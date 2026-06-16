/**
 * Conclave — Opinion routes
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { AskOpinionSchema, SubmitOpinionResponseSchema, CreateNodeSchema, GraphQuerySchema } from '../schemas/index.js';
import { OpinionService } from '../services/opinions.js';
import { BlackboardService } from '../services/blackboard.js';
import { BudgetService, BUDGET } from '../services/budget.js';
import { AgentService } from '../services/agents.js';
import { ChannelService } from '../services/channels.js';
import * as schema from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { pulseHub } from '../services/pulse.js';
import { success, error, ERROR_CODES } from '../utils/response.js';
import { randomUUID } from 'crypto';

export const opinionRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  const db = fastify.db;
  const opinionSvc = new OpinionService(db);
  const budgetSvc = new BudgetService(db);
  const agentSvc = new AgentService(db);
  const channelSvc = new ChannelService(db);
  const bbSvc = new BlackboardService(db);

  // POST /v1/opinions
  fastify.post('/opinions', async (request, reply) => {
    const parsed = AskOpinionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }
    const data = parsed.data;
    const agentId = (request as any).agentId ?? 'agt_dev';
    const agent = await agentSvc.getById(agentId);
    // Use provided principal_id from request body, or fall back to agent's principal, or auth principal, or dev
    const principalId = data.principal_id ?? agent?.principal_id ?? (request as any).principalId ?? 'prn_dev';

    // Verify principal is subscribed to the target channel
    const channel = await channelSvc.getByName(data.channel);
    if (channel && principalId && principalId !== 'prn_dev') {
      const subscribed = await channelSvc.isSubscribed(principalId, channel.id);
      if (!subscribed) {
        return reply.code(403).send(error(ERROR_CODES.NOT_SUBSCRIBED.code, 'Principal is not subscribed to this channel', {
          channel: data.channel,
          principal_id: principalId,
        }));
      }
    }

    const id = `opn_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    // Initial budget spend for asking
    const initialSpent = await budgetSvc.spend(principalId, BUDGET.ASK_OPINION, 'ask_opinion', id);
    if (!initialSpent) {
      const balance = await budgetSvc.getByPrincipal(principalId);
      return reply.code(402).send(error(ERROR_CODES.INSUFFICIENT_BUDGET.code, 'Insufficient budget', {
        current_budget: balance?.available ?? 0,
        required: BUDGET.ASK_OPINION,
      }));
    }

    const opinion = await opinionSvc.create({
      id,
      agentId,
      principalId,
      question: data.question,
      context: data.context,
      channel: data.channel,
      requestedOpinions: data.requested_critics,
      deadline: data.deadline,
      metadata: data.metadata as Record<string, unknown> | undefined,
      budgetSpent: BUDGET.ASK_OPINION,
    });

    // Auto-create ProposalNode on the Blackboard
    try {
      const proposalNodeId = `nd_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      await bbSvc.createNode({
        id: proposalNodeId,
        opinionId: id,
        agentId,
        principalId,
        kind: 'proposal',
        payload: { question: data.question, context: data.context },
      });
    } catch (bbErr: any) {
      console.warn(`[opinions] ProposalNode creation failed (non-fatal): ${bbErr.message}`);
    }

    // Notify opinion router
    try {
      const pgClient = (fastify as any).pgClient;
      if (pgClient && typeof pgClient.notify === 'function') {
        await pgClient.notify('new_opinion', id);
      } else if (pgClient) {
        await pgClient.query(`SELECT pg_notify('new_opinion', $1)`, [id]);
      }
    } catch (notifyErr: any) {
      console.warn(`[opinions] pg_notify failed (non-fatal): ${notifyErr.message}`);
    }

    reply.code(201).send(success(opinion));
  });

  // GET /v1/opinions
  fastify.get('/opinions', async (request: any, reply) => {
    const query = request.query as any;
    const opinions = await opinionSvc.list({
      channel: query.channel,
      principalId: query.principal_id,
      status: query.status,
    });
    reply.send(success({ opinions, total: opinions.length }));
  });

  // GET /v1/opinions/:id
  fastify.get('/opinions/:id', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const opinion = await opinionSvc.getById(id);
    if (!opinion) return reply.code(404).send(error('OPINION_NOT_FOUND', 'Opinion not found'));
    const responses = await opinionSvc.getResponsesForOpinion(id);
    reply.send(success({ ...opinion, responses_received: responses.length, responses }));
  });

  // POST /v1/opinions/:id/responses
  fastify.post('/opinions/:id/responses', async (request, reply) => {
    const { id: opinionId } = request.params as { id: string };
    const parsed = SubmitOpinionResponseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }
    const data = parsed.data;
    const respondentId = (request as any).agentId ?? 'agt_responder_dev';
    const respondent = await agentSvc.getById(respondentId);
    const principalId = respondent?.principal_id ?? (request as any).principalId ?? 'prn_dev';

    const responseId = `rsp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const resp = await opinionSvc.submitResponse({
      id: responseId,
      opinionId,
      respondentId,
      principalId,
      response: data.response,
      confidence: data.confidence,
      reasoning: data.reasoning,
      references: data.references,
      metadata: data.metadata as Record<string, unknown> | undefined,
    });

    // Also create a SynthesisNode for the worker to detect (unified graph model)
    const { BlackboardService } = await import('../services/blackboard.js');
    const bbSvc = new BlackboardService(fastify.db);
    const { v7: uuidv7 } = await import('uuid');
    await bbSvc.createNode({
      id: `nd_${uuidv7().replace(/-/g, '').slice(0, 24)}`,
      opinionId,
      agentId: respondentId,
      principalId,
      kind: 'synthesis',
      payload: {
        response: data.response,
        confidence: data.confidence,
        reasoning: data.reasoning,
        references: data.references,
      },
    });

    // Notify worker (in case it's listening)
    try {
      const pgClient = (fastify as any).pg;
      if (pgClient) {
        await pgClient.query(`SELECT pg_notify('opinion_node_submitted', $1)`, [opinionId]);
      }
    } catch (notifyErr: any) {
      console.warn(`[opinions] pg_notify failed (non-fatal): ${notifyErr.message}`);
    }

    // Earn budget for answering
    await budgetSvc.earn(principalId, BUDGET.ANSWER_OPINION, 'answer_opinion', responseId);

    reply.code(201).send(success(resp));
  });

  // ─── Blackboard Routes ──────────────────────────────────

  // POST /v1/opinions/:opinionId/nodes
  fastify.post('/opinions/:opinionId/nodes', async (request, reply) => {
    const { opinionId } = request.params as { opinionId: string };

    // Verify opinion exists
    const opinion = await opinionSvc.getById(opinionId);
    if (!opinion) return reply.code(404).send(error('OPINION_NOT_FOUND', 'Opinion not found'));
    if (opinion.status === 'closed' || opinion.status === 'consensus_reached') {
      return reply.code(409).send(error('OPINION_CLOSED', 'Opinion is already closed or consensus reached'));
    }

    const parsed = CreateNodeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }
    const data = parsed.data;

    // Only allow synthesis when opinion is in synthesizing status
    if (data.kind === 'synthesis' && opinion.status !== 'synthesizing') {
      return reply.code(409).send(error('NOT_SYNTHESIZABLE', 'Synthesis can only be submitted when all critiques are received'));
    }

    const agentId = (request as any).agentId ?? 'agt_dev';
    const agent = await agentSvc.getById(agentId);
    const principalId = agent?.principal_id ?? (request as any).principalId ?? 'prn_dev';

    const nodeId = `nd_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const node = await bbSvc.createNode({
      id: nodeId,
      opinionId,
      agentId,
      principalId,
      kind: data.kind,
      payload: data.content,
    });

    // If there's a parent edge, link it
    if (data.parent_node_id && data.parent_edge_kind) {
      const edgeId = `e_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      await bbSvc.createEdge({
        id: edgeId,
        opinionId,
        sourceNodeId: data.parent_node_id,
        targetNodeId: nodeId,
        kind: data.parent_edge_kind,
      });
    }

    reply.code(201).send(success(node));

    // ─── Notify worker ───────────────────────────────────────
    try {
      const pgClient = (fastify as any).pg;
      if (pgClient) {
        await pgClient.query(`SELECT pg_notify('opinion_node_submitted', $1)`, [opinionId]);
      }
    } catch (notifyErr: any) {
      console.warn(`[opinions] pg_notify failed (non-fatal): ${notifyErr.message}`);
    }

    // ─── Budget hooks ────────────────────────────────────────
    // ProposalNode costs -3 (already spent at opinion creation)
    // First CritiqueNode earns +2 per critic
    // SynthesisNode, follow-up CritiqueNode, ConsensusNode cost/earn nothing
    try {
      if (data.kind === 'critique') {
        // Check if this is the first critique from this principal on this opinion
        const existingCritiques = await db.select({ id: schema.blackboardNodes.id })
          .from(schema.blackboardNodes)
          .where(and(
            eq(schema.blackboardNodes.opinionId, opinionId),
            eq(schema.blackboardNodes.kind, 'critique'),
            eq(schema.blackboardNodes.principalId, principalId),
          )).limit(2);
        // Only earn +2 for first critique per principal
        if (existingCritiques.length <= 1) {
          await budgetSvc.earn(principalId, BUDGET.ANSWER_OPINION, 'critique_node', nodeId);
        }
      }
    } catch (budgetErr: any) {
      console.warn(`[opinions] Budget hook failed (non-fatal): ${budgetErr.message}`);
    }

    // ─── Pulse SSE events ────────────────────────────────────
    try {
      const orgId = agent?.org_id ?? 'org_dev';
      const statusRow = await db.select({ status: schema.opinions.status, closeTag: schema.opinions.closeTag })
        .from(schema.opinions).where(eq(schema.opinions.id, opinionId)).limit(1);
      const currentStatus = (statusRow as any[])?.[0]?.status ?? 'open';
      const currentCloseTag = (statusRow as any[])?.[0]?.closeTag ?? undefined;

      // Opinion status changed event (if status differs from what it was)
      pulseHub.broadcastToOrg(orgId, {
        type: 'OPINION_STATUS_CHANGED',
        payload: { opinion_id: opinionId, status: currentStatus, close_tag: currentCloseTag },
      });

      // Node added event
      pulseHub.broadcastToOrg(orgId, {
        type: 'OPINION_NODE_ADDED',
        payload: {
          opinion_id: opinionId,
          node_id: nodeId,
          payload_type: data.kind,
          author_role: data.kind === 'proposal' ? 'proposer' : data.kind === 'critique' ? 'critic' : data.kind === 'synthesis' ? 'synthesizer' : 'voter',
        },
      });
    } catch (pulseErr: any) {
      console.warn(`[opinions] Pulse broadcast failed (non-fatal): ${pulseErr.message}`);
    }
  });

  // GET /v1/opinions/:opinionId/graph
  fastify.get('/opinions/:opinionId/graph', async (request, reply) => {
    const { opinionId } = request.params as { opinionId: string };

    const opinion = await opinionSvc.getById(opinionId);
    if (!opinion) return reply.code(404).send(error('OPINION_NOT_FOUND', 'Opinion not found'));

    const graph = await bbSvc.getGraph(opinionId);
    const consensus = await bbSvc.checkConsensus(opinionId);

    reply.send(success({ ...graph, consensus }));
  });

  done();
};
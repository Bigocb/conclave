/**
 * Conclave — Opinion routes
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { AskOpinionSchema, SubmitOpinionResponseSchema } from '../schemas/index.js';
import { OpinionService } from '../services/opinions.js';
import { BudgetService, BUDGET } from '../services/budget.js';
import { AgentService } from '../services/agents.js';
import { ChannelService } from '../services/channels.js';
import { success, error, ERROR_CODES } from '../utils/response.js';
import { randomUUID } from 'crypto';

export const opinionRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  const db = fastify.db;
  const opinionSvc = new OpinionService(db);
  const budgetSvc = new BudgetService(db);
  const agentSvc = new AgentService(db);
  const channelSvc = new ChannelService(db);

  // POST /v1/opinions
  fastify.post('/opinions', async (request, reply) => {
    const parsed = AskOpinionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }
    const data = parsed.data;
    const agentId = (request as any).agentId ?? 'agt_dev';
    const agent = await agentSvc.getById(agentId);
    const principalId = agent?.principal_id ?? (request as any).principalId ?? 'prn_dev';

    // Verify principal is subscribed to the target channel
    const channel = await channelSvc.getByName(data.channel);
    if (channel && agent?.principal_id) {
      const subcribed = await channelSvc.isSubscribed(agent.principal_id, channel.id);
      if (!subcribed) {
        return reply.code(403).send(error(ERROR_CODES.NOT_SUBSCRIBED.code, 'Principal is not subscribed to this channel', {
          channel: data.channel,
          principal_id: agent.principal_id,
        }));
      }
    }

    const id = `opn_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    // Spend budget
    const spent = await budgetSvc.spend(principalId, BUDGET.ASK_OPINION, 'ask_opinion', id);
    if (!spent) {
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
      requestedOpinions: data.requested_opinions,
      deadline: data.deadline,
      metadata: data.metadata as Record<string, unknown> | undefined,
      budgetSpent: BUDGET.ASK_OPINION,
    });

    reply.code(201).send(success(opinion));
  });

  // GET /v1/opinions
  fastify.get('/opinions', async (request: any, reply) => {
    const query = request.query as any;
    const opinions = await opinionSvc.list({
      channel: query.channel,
      principalId: query.principal_id,
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

    // Earn budget for answering
    await budgetSvc.earn(principalId, BUDGET.ANSWER_OPINION, 'answer_opinion', responseId);

    reply.code(201).send(success(resp));
  });

  done();
};
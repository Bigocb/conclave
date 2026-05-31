/**
 * Conclave — Principal routes
 * REST endpoints for managing principals (durable identities)
 */

import { FastifyInstance } from 'fastify';
import * as crypto from 'crypto';
import { PrincipalService } from '../services/principals.js';
import { AgentService } from '../services/agents.js';
import { BudgetService } from '../services/budget.js';
import { ReputationService } from '../services/reputation.js';
import { OrgService } from '../services/orgs.js';
import { MemoryService } from '../services/memory.js';
import { success, error, ERROR_CODES } from '../utils/response.js';
import { CreatePrincipalSchema, UpdatePrincipalSchema, RegisterAgentSchema, UpdateAgentSchema, PatchAgentSchema } from '../schemas/index.js';
import { authenticate } from '../middleware/auth.js';

export async function principalRoutes(fastify: FastifyInstance) {
    const principalService = new PrincipalService(fastify.db);
    const agentService = new AgentService(fastify.db);
    const budgetService = new BudgetService(fastify.db);
    const reputationService = new ReputationService(fastify.db);
    const orgService = new OrgService(fastify.db);
    const memoryService = new MemoryService(fastify.db);

  // Middleware: All principal routes require valid user session
  fastify.addHook('preHandler', authenticate);

  // POST /v1/principals — Create principal
  fastify.post('/principals', async (request, reply) => {
    const parse = CreatePrincipalSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', parse.error.issues.map(i => i.message).join(', ')));
    }
    const data = parse.data;

    // Enforce Org Isolation: User can only create principals in their current org context
    const currentOrgId = (request as any).orgId;
    if (!currentOrgId || data.org_id !== currentOrgId) {
      return reply.status(403).send(error('FORBIDDEN', 'You do not have permission to create principals for this organization'));
    }

    const id = `prn_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const principal = await principalService.create({
      id,
      orgId: data.org_id,
      name: data.name,
      roles: data.roles,
      capabilities: data.capabilities,
      metadata: data.metadata,
    });
    return reply.status(201).send(success(principal));
  });

  // GET /v1/principals — List principals
  fastify.get('/principals', async (request, reply) => {
    const { role, status, page, per_page } = request.query as any;
    const currentOrgId = (request as any).orgId;

    if (!currentOrgId) {
      return reply.status(403).send(error('UNAUTHORIZED', 'No active organization context'));
    }

    const principals = await principalService.list({ 
      org: currentOrgId, 
      role, 
      status, 
      page, 
      perPage: per_page 
    });
    return reply.send(success(principals));
  });

  // GET /v1/principals/:id — Get principal
  fastify.get('/principals/:id', async (request, reply) => {
    const { id } = request.params as any;
    const principal = await principalService.getById(id);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }
    const agents = await principalService.getAgents(id);
    return reply.send(success({ ...principal, agents }));
  });

  // GET /v1/principals/:id/memory — List memories for principal
  fastify.get('/principals/:id/memory', async (request, reply) => {
    const { id: principalId } = request.params as any;
    const { channel, keyPrefix } = request.query as any;
    
    const principal = await principalService.getById(principalId);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }

    const memories = await memoryService.getForPrincipal({
      principalId,
      channel,
      keyPrefix,
    });
    return reply.send(success(memories));
  });

  // POST /v1/principals/:id/memory — Create memory entry
  fastify.post('/principals/:id/memory', async (request, reply) => {
    const { id: principalId } = request.params as any;
    const principal = await principalService.getById(principalId);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }

    const data = request.body as any;
    if (!data.key || !data.value) {
      return reply.status(422).send(error('VALIDATION_ERROR', 'Key and value are required'));
    }

    const memory = await memoryService.create({
      principalId,
      orgId: principal.org_id,
      channel: data.channel,
      key: data.key,
      value: data.value,
      category: data.category,
      sourceTaskId: data.sourceTaskId,
      sourceReviewId: data.sourceReviewId,
    });
    return reply.status(201).send(success(memory));
  });

  // PATCH /v1/principals/:id/memory/:memId — Update memory entry
  fastify.patch('/principals/:id/memory/:memId', async (request, reply) => {
    const { id: principalId, memId } = request.params as any;
    const data = request.body as any;
    
    const memory = await memoryService.update(memId, data);
    if (!memory) {
      return reply.status(404).send(error('MEMORY_NOT_FOUND', 'Memory entry not found'));
    }
    return reply.send(success(memory));
  });

  // DELETE /v1/principals/:id/memory/:memId — Delete memory entry
  fastify.delete('/principals/:id/memory/:memId', async (request, reply) => {
    const { id: principalId, memId } = request.params as any;
    const memory = await memoryService.delete(memId);
    if (!memory) {
      return reply.status(404).send(error('MEMORY_NOT_FOUND', 'Memory entry not found'));
    }
    return reply.send(success({ deleted: true, id: memId }));
  });

  // PUT /v1/principals/:id — Update principal
  fastify.put('/principals/:id', async (request, reply) => {
    const { id } = request.params as any;
    const parse = UpdatePrincipalSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', parse.error.issues.map(i => i.message).join(', ')));
    }
    const principal = await principalService.update(id, parse.data);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }
    return reply.send(success(principal));
  });

  // DELETE /v1/principals/:id — Decommission principal
  fastify.delete('/principals/:id', async (request, reply) => {
    const { id } = request.params as any;
    const principal = await principalService.getById(id);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }
    await principalService.deactivate(id);
    return reply.send(success({ decommissioned: true, id }));
  });

  // GET /v1/principals/:id/agents — List agents for principal
  fastify.get('/principals/:id/agents', async (request, reply) => {
    const { id } = request.params as any;
    const principal = await principalService.getById(id);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }
    const agents = await principalService.getAgents(id);
    return reply.send(success(agents));
  });

  // POST /v1/principals/:id/agents — Register agent under principal
  fastify.post('/principals/:id/agents', async (request, reply) => {
    const { id: principalId } = request.params as any;
    const principal = await principalService.getById(principalId);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }

    const parse = RegisterAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', parse.error.issues.map(i => i.message).join(', ')));
    }
    const data = parse.data;
    const agentId = `agt_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const token = `clv_${crypto.randomUUID().replace(/-/g, '').slice(0, 32)}`;

    const agent = await agentService.create({
      id: agentId,
      principalId,
      orgId: principal.org_id,
      name: data.name,
      token,
      model: data.model,
      provider: data.provider,
      llmUrl: data.llm_url,
      type: data.type,
      command: data.command,
      instructions: data.instructions,
      skills: data.skills,
    });

    return reply.status(201).send(success({ ...agent, token }));
  });

  // GET /v1/principals/:id/budget — Get principal budget
  fastify.get('/principals/:id/budget', async (request, reply) => {
    const { id } = request.params as any;
    const principal = await principalService.getById(id);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }
    const budget = await budgetService.getByPrincipal(id);
    if (!budget) {
      return reply.status(404).send(error('BUDGET_NOT_FOUND', 'No budget record for principal'));
    }
    return reply.send(success(budget));
  });

  // GET /v1/principals/:id/reputation — Get principal reputation
  fastify.get('/principals/:id/reputation', async (request, reply) => {
    const { id } = request.params as any;
    const principal = await principalService.getById(id);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }
    const reputation = await reputationService.getByPrincipal(id);
    return reply.send(success(reputation));
  });

  // GET /v1/principals/:id/reviewers — List all reviewers (agents) for a principal with full config
  fastify.get('/principals/:id/reviewers', async (request, reply) => {
    const { id } = request.params as any;
    const principal = await principalService.getById(id);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }
    const reviewers = await agentService.getReviewers(id);
    return reply.send(success(reviewers));
  });

  // PUT /v1/principals/:id/reviewers/:agentId — Full update of reviewer (agent) config
  fastify.put('/principals/:id/reviewers/:agentId', async (request, reply) => {
    const { id: principalId, agentId } = request.params as any;

    const principal = await principalService.getById(principalId);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }

    const parse = UpdateAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', parse.error.issues.map(i => i.message).join(', ')));
    }

    const existingAgent = await agentService.getById(agentId);
    if (!existingAgent) {
      return reply.status(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
    }
    if (existingAgent.principal_id !== principalId) {
      return reply.status(403).send(error(ERROR_CODES.FORBIDDEN.code, 'Agent does not belong to this principal'));
    }

    const updated = await agentService.update(agentId, parse.data);
    return reply.send(success(updated));
  });

  // PATCH /v1/principals/:id/reviewers/:agentId — Partial update of reviewer (agent) config
  fastify.patch('/principals/:id/reviewers/:agentId', async (request, reply) => {
    const { id: principalId, agentId } = request.params as any;

    const principal = await principalService.getById(principalId);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }

    const parse = PatchAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', parse.error.issues.map(i => i.message).join(', ')));
    }

    const existingAgent = await agentService.getById(agentId);
    if (!existingAgent) {
      return reply.status(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
    }
    if (existingAgent.principal_id !== principalId) {
      return reply.status(403).send(error(ERROR_CODES.FORBIDDEN.code, 'Agent does not belong to this principal'));
    }

    const updated = await agentService.update(agentId, parse.data);
    return reply.send(success(updated));
  });
}
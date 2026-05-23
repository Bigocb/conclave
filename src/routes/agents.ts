/**
 * Conclave — Agent routes
 * REST endpoints for agent management
 */

import { FastifyInstance } from 'fastify';
import * as crypto from 'crypto';
import { AgentService } from '../services/agents.js';
import { success, error, ERROR_CODES } from '../utils/response.js';
import { RegisterAgentSchema, UpdateAgentSchema, AgentQuerySchema } from '../schemas/index.js';

export async function agentRoutes(fastify: FastifyInstance) {
  const agentService = new AgentService(fastify.db);

  // POST /v1/agents/register — Register a new agent under a principal
  fastify.post('/agents/register', async (request, reply) => {
    const parse = RegisterAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', parse.error.issues.map(i => i.message).join(', ')));
    }
    const data = parse.data;

    // Look up the principal to get org_id
    const { PrincipalService } = await import('../services/principals.js');
    const principalService = new PrincipalService(fastify.db);
    const principal = await principalService.getById(data.principal_id);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }

    const agentId = `agt_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const token = `clv_${crypto.randomUUID().replace(/-/g, '').slice(0, 32)}`;

    const agent = await agentService.create({
      id: agentId,
      principalId: data.principal_id,
      orgId: principal.org_id,
      name: data.name,
      token,
      model: data.model,
      provider: data.provider,
      llmUrl: data.llm_url,
    });

    return reply.status(201).send(success({ ...agent, token }));
  });

  // GET /v1/agents — Discover agents
  fastify.get('/agents', async (request, reply) => {
    const query = AgentQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', query.error.issues.map(i => i.message).join(', ')));
    }
    const agents = await agentService.list({
      org: query.data.org,
      principal: query.data.principal,
      page: query.data.page,
      perPage: query.data.per_page,
    });
    return reply.send(success(agents));
  });

  // GET /v1/agents/:id — Get agent profile
  fastify.get('/agents/:id', async (request, reply) => {
    const { id } = request.params as any;
    const agent = await agentService.getById(id);
    if (!agent) {
      return reply.status(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
    }

    // Include principal info
    const { PrincipalService } = await import('../services/principals.js');
    const principalService = new PrincipalService(fastify.db);
    const principal = await principalService.getById(agent.principal_id);

    return reply.send(success({
      ...agent,
      principal: principal ? { id: principal.id, name: principal.name, roles: principal.roles } : null,
    }));
  });

  // PUT /v1/agents/:id — Update agent (full replacement)
  fastify.put('/agents/:id', async (request, reply) => {
    const { id } = request.params as any;
    const parse = UpdateAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', parse.error.issues.map(i => i.message).join(', ')));
    }
    const agent = await agentService.update(id, parse.data);
    if (!agent) {
      return reply.status(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
    }
    return reply.send(success(agent));
  });

  // PATCH /v1/agents/:id — Partial update (e.g. swap model/provider at runtime)
  fastify.patch('/agents/:id', async (request, reply) => {
    const { id } = request.params as any;
    const parse = UpdateAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', parse.error.issues.map(i => i.message).join(', ')));
    }
    let data = parse.data;

    // Resolve provider shortcut to llm_url if provider given without llm_url
    if (data.provider && !data.llm_url) {
      const { BUILTIN_PROVIDERS } = await import('../fleet/config.js');
      const resolved = BUILTIN_PROVIDERS[data.provider];
      if (resolved) {
        data = { ...data, llm_url: resolved };
      }
    }

    const agent = await agentService.update(id, data);
    if (!agent) {
      return reply.status(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
    }
    return reply.send(success(agent));
  });

  // DELETE /v1/agents/:id — Decommission agent
  fastify.delete('/agents/:id', async (request, reply) => {
    const { id } = request.params as any;
    const agent = await agentService.getById(id);
    if (!agent) {
      return reply.status(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
    }
    await agentService.deactivate(id);
    return reply.send(success({ decommissioned: true, id }));
  });
}
/**
 * Conclave — Agent routes
 * REST endpoints for agent management
 */

import { FastifyInstance } from 'fastify';
import * as crypto from 'crypto';
import { AgentService } from '../services/agents.js';
import { VaultService } from '../services/vault.js';
import { success, error, ERROR_CODES } from '../utils/response.js';
import { RegisterAgentSchema, UpdateAgentSchema, AgentQuerySchema } from '../schemas/index.js';
import { authenticate } from '../middleware/auth.js';

export async function agentRoutes(fastify: FastifyInstance) {
  const agentService = new AgentService(fastify.db);

  // Middleware: All agent routes require valid user session
  fastify.addHook('preHandler', authenticate);

  // GET /v1/agents/me — Resolve current identity from token (clv_ or JWT)
  fastify.get('/agents/me', async (request, reply) => {
    const req = request as any;
    const agentId = req.agentId;
    const principalId = req.principalId;
    const orgId = req.orgId;

    if (!agentId && !principalId) {
      return reply.status(401).send(error('UNAUTHORIZED', 'No agent or principal identity resolved from token'));
    }

    return reply.send(success({
      agent_id: agentId || null,
      principal_id: principalId || null,
      org_id: orgId || null,
    }));
  });

  // POST /v1/agents/register — Register a new agent under a principal
    fastify.post('/agents/register', async (request, reply) => {
    const parse = RegisterAgentSchema.safeParse(request.body);
    if (!parse.success) {
      console.error('[Agent Registration] Validation Error:', JSON.stringify(parse.error.format()));
      return reply.status(422).send(error('VALIDATION_ERROR', parse.error.issues.map(i => i.message).join(', ')));
    }
    const data = parse.data;

    const { PrincipalService } = await import('../services/principals.js');
    const principalService = new PrincipalService(fastify.db);
    const principal = await principalService.getById(data.principal_id);
    if (!principal) {
      return reply.status(404).send(error(ERROR_CODES.PRINCIPAL_NOT_FOUND.code, 'Principal not found'));
    }

    const currentOrgId = (request as any).orgId;
    if (!currentOrgId || principal.org_id !== currentOrgId) {
      return reply.status(403).send(error('FORBIDDEN', 'You do not have permission to manage agents for this principal as it belongs to another organization'));
    }

    const agentId = `agt_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const token = `clv_${crypto.randomUUID().replace(/-/g, '').slice(0, 32)}`;
    const vault = new VaultService(fastify.db);

    try {
      // Atomic operation: Create agent + store API key in vault
      await fastify.db.transaction(async (tx) => {
        const agent = await agentService.create({
          id: agentId,
          principalId: data.principal_id,
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

        // If provider is specified, we expect an api_key in the request body
        if (data.provider) {
          const apiKey = (request.body as any).api_key;
          if (!apiKey) throw new Error('API key is required for nominated providers');
          await vault.storeSecret(`agent:${agentId}:key`, apiKey);
        }
      });

      const finalAgent = await agentService.getById(agentId);
      return reply.status(201).send(success({ ...finalAgent, token }));
    } catch (e: any) {
      return reply.status(500).send(error('INTERNAL_ERROR', e.message));
    }
  });

  // GET /v1/agents — Discover agents
  fastify.get('/agents', async (request, reply) => {
    const query = AgentQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(422).send(error('VALIDATION_ERROR', query.error.issues.map(i => i.message).join(', ')));
    }
    const statusFilter = query.data.status === 'all' ? undefined : (query.data.status || 'active');
    const currentOrgId = (request as any).orgId;

    if (!currentOrgId) {
      return reply.status(403).send(error('UNAUTHORIZED', 'No active organization context'));
    }

    const agents = await agentService.list({
      org: currentOrgId, // Force filtering by user's org, ignoring request query if provided
      principal: query.data.principal,
      status: statusFilter,
      page: query.data.page,
      perPage: query.data.per_page,
    });
    return reply.send(success(agents));
  });

  // GET /v1/agents/:id — Get agent profile
  fastify.get('/agents/:id', async (request, reply) => {
    const { id } = request.params as any;
    const includeKey = (request.query as any)?.include_key === 'true';
    const agent = await agentService.getById(id);
    if (!agent) {
      return reply.status(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
    }

    // Org Isolation check
    const currentOrgId = (request as any).orgId;
    if (!currentOrgId || agent.org_id !== currentOrgId) {
      return reply.status(403).send(error('FORBIDDEN', 'This agent belongs to a different organization'));
    }

    const { PrincipalService } = await import('../services/principals.js');
    const principalService = new PrincipalService(fastify.db);
    const principal = await principalService.getById(agent.principal_id);

    // Optionally resolve vault key for this agent
    let vaultKey: string | null = null;
    if (includeKey && agent.provider) {
      const vault = new VaultService(fastify.db);
      // Try agent-specific key first, then provider key
      vaultKey = await vault.getSecret(`agent:${agent.id}:key`) 
        || await vault.getSecret(agent.provider);
    }

    const response: any = {
      ...agent,
      principal: principal ? { id: principal.id, name: principal.name, roles: principal.roles } : null,
    };
    
    // Only include the key if explicitly requested
    if (includeKey && vaultKey) {
      response.vault_key = vaultKey;
    }

    return reply.send(success(response));
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

  // GET /v1/agents/:id/subscriptions — Get channels this agent's principal is subscribed to
  fastify.get('/agents/:id/subscriptions', async (request, reply) => {
    const { id } = request.params as any;
    const agent = await agentService.getById(id);
    if (!agent) {
      return reply.status(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
    }
    const db = (fastify as any).db;
    const { channelSubscriptions, channels } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const subs = await db.select({
      channelId: channelSubscriptions.channelId,
      channelName: channels.name,
    }).from(channelSubscriptions)
      .innerJoin(channels, eq(channelSubscriptions.channelId, channels.id))
      .where(eq(channelSubscriptions.principalId, agent.principal_id));
    return reply.send(success({ channels: subs.map((s: any) => s.channelName) }));
  });

  // POST /v1/agents/:id/regenerate-token — Generate a new clv_ token for an agent
  fastify.post('/agents/:id/regenerate-token', async (request, reply) => {
    const { id } = request.params as any;
    const agent = await agentService.getById(id);
    if (!agent) {
      return reply.status(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
    }

    // Org isolation
    const currentOrgId = (request as any).orgId;
    if (!currentOrgId || agent.org_id !== currentOrgId) {
      return reply.status(403).send(error('FORBIDDEN', 'This agent belongs to a different organization'));
    }

    const newToken = `clv_${crypto.randomUUID().replace(/-/g, '').slice(0, 32)}`;
    await agentService.update(id, { token: newToken } as any);
    return reply.send(success({ agent_id: id, token: newToken }));
  });
}
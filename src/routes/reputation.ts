/**
 * Conclave — Reputation routes
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { ReputationService } from '../services/reputation.js';
import { AgentService } from '../services/agents.js';
import { success } from '../utils/response.js';

export const reputationRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  const db = fastify.db;
  const repSvc = new ReputationService(db);
  const agentSvc = new AgentService(db);

  // GET /v1/reputation/:id — resolves agent or principal ID
  fastify.get('/reputation/:id', async (request: any, reply) => {
    const { id } = request.params as { id: string };

    if (id.startsWith('agt_')) {
      const agent = await agentSvc.getById(id);
      if (!agent) {
        return reply.code(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));
      }
      
      const currentOrgId = (request as any).orgId;
      if (!currentOrgId || agent.org_id !== currentOrgId) {
        return reply.code(403).send(error('FORBIDDEN', 'Access to this agent\'s reputation is restricted to its organization'));
      }

      const rep = await repSvc.getByPrincipal(agent.principal_id);
      return reply.send(success({ ...rep, agent_id: id }));
    }

    const rep = await repSvc.getByPrincipal(id);
    if (!rep) return reply.code(404).send(error('NOT_FOUND', 'Reputation record not found'));
    
    reply.send(success(rep));
  });

  fastify.get('/leaderboard', async (request: any, reply) => {
    const query = request.query as any;
    const leaderboard = await repSvc.getLeaderboard(
      query.dimension,
      parseInt(query.limit ?? '20'),
    );
    reply.send(success({ leaders: leaderboard, period: query.period ?? 'all' }));
  });

  done();
};
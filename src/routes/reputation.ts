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

    // If it's an agent ID, resolve to principal
    if (id.startsWith('agt_')) {
      const agent = await agentSvc.getById(id);
      if (!agent) {
        const rep = await repSvc.getByPrincipal(id);
        return reply.send(success(rep));
      }
      const rep = await repSvc.getByPrincipal(agent.principal_id);
      return reply.send(success({ ...rep, agent_id: id }));
    }

    // If it's a principal ID, get directly
    const rep = await repSvc.getByPrincipal(id);
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
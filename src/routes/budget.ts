/**
 * Conclave — Budget routes
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { BudgetService } from '../services/budget.js';
import { AgentService } from '../services/agents.js';
import { success, error, ERROR_CODES } from '../utils/response.js';

export const budgetRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  const db = fastify.db;
  const budgetSvc = new BudgetService(db);
  const agentSvc = new AgentService(db);

  // GET /v1/agents/:id/budget — Get budget for agent (resolves to principal)
  fastify.get('/agents/:id/budget', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const budget = await budgetSvc.getByAgent(id);
    if (!budget) return reply.code(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent/principal budget not found'));
    const history = await budgetSvc.getHistory(budget.principal_id);
    reply.send(success({ agent_id: id, ...budget, history }));
  });

  // GET /v1/principals/:id/budget — Get budget for principal (defined in principal routes)

  done();
};
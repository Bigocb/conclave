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
    const agent = await agentSvc.getById(id);
    
    if (!agent) return reply.code(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent not found'));

    // Org Isolation: Agent must belong to the user's current organization
    const currentOrgId = (request as any).orgId;
    if (!currentOrgId || agent.org_id !== currentOrgId) {
      return reply.code(403).send(error('FORBIDDEN', 'This agent belongs to a different organization'));
    }

    const budget = await budgetSvc.getByAgent(id);
    if (!budget) return reply.code(404).send(error(ERROR_CODES.AGENT_NOT_FOUND.code, 'Agent/principal budget not found'));
    const history = await budgetSvc.getHistory(budget.principal_id);
    reply.send(success({ agent_id: id, ...budget, history }));
  });

  // GET /v1/principals/:id/budget — Get principal budget (defined in principal routes)

  // POST /v1/principals/:id/budget/grant — Manually add budget to a principal
  fastify.post('/principals/:id/budget/grant', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const { amount, reason } = request.body as { amount: number; reason?: string };
    const currentOrgId = (request as any).orgId;
    if (!currentOrgId) return reply.code(403).send(error('FORBIDDEN', 'No org context'));
    const orgId: string = currentOrgId;

    if (!amount || amount <= 0) return reply.code(422).send(error('VALIDATION_ERROR', 'Amount must be positive'));
    const imported = await import('../services/principals.js');
    const principal = await (new imported.PrincipalService(this.db)).getById(id);
    if (!principal || !principal.org_id || principal.org_id !== orgId) return reply.code(404).send(error('PRINCIPAL_NOT_FOUND', 'Principal not found'));

    await budgetSvc.earn(id, amount, reason || 'manual_grant');
    const budget = await budgetSvc.getByPrincipal(id);
    reply.send(success({ granted: amount, new_balance: budget }));
  });

  done();
};
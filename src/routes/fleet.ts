/**
 * Conclave — Fleet API Routes
 *
 * Endpoints for interacting with a running fleet manager:
 *   GET  /v1/fleet/status    — fleet stats
 *   GET  /v1/fleet/pending   — pending human approvals
 *   POST /v1/fleet/approve   — approve a pending review
 *   POST /v1/fleet/reject    — reject a pending review
 *
 * These routes are mounted when the server is run in fleet mode
 * (i.e. a FleetManager instance is provided).
 */

import { FastifyInstance } from 'fastify';
import { FleetManager, PendingReview } from '../fleet/manager.js';
import { discoverLocalModels } from '../fleet/discover.js';
import { success, error } from '../utils/response.js';

export async function fleetRoutes(fastify: FastifyInstance, manager: FleetManager) {

  // GET /v1/fleet/status
  fastify.get('/fleet/status', async (_request, reply) => {
    const stats = manager.getStats();
    reply.send(success(stats));
  });

  // GET /v1/fleet/discover — Probe local LLM runtimes for available models
  fastify.get('/fleet/discover', async (_request, reply) => {
    try {
      const models = await discoverLocalModels();
      reply.send(success({ models, total: models.length }));
    } catch (err: any) {
      reply.code(500).send(error('DISCOVERY_ERROR', err.message));
    }
  });

  // GET /v1/fleet/pending
  fastify.get('/fleet/pending', async (_request, reply) => {
    const pending = manager.getPendingApprovals();
    reply.send(success({ pending, total: pending.length }));
  });

  // POST /v1/fleet/approve
  fastify.post('/fleet/approve', async (request, reply) => {
    const body = request.body as any;
    const pendingId = body?.pending_id;
    if (!pendingId) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'pending_id is required'));
    }

    const edits = body?.edits;

    try {
      await manager.approvePending(pendingId, edits);
      const pending = manager.getPendingApprovals(); // refresh
      reply.send(success({
        pending_id: pendingId,
        status: 'approved',
        remaining_pending: pending.length,
      }));
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.code(404).send(error('NOT_FOUND', err.message));
      }
      reply.code(500).send(error('INTERNAL_ERROR', err.message));
    }
  });

  // POST /v1/fleet/reject
  fastify.post('/fleet/reject', async (request, reply) => {
    const body = request.body as any;
    const pendingId = body?.pending_id;
    if (!pendingId) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'pending_id is required'));
    }

    try {
      manager.rejectPending(pendingId);
      const pending = manager.getPendingApprovals();
      reply.send(success({
        pending_id: pendingId,
        status: 'rejected',
        remaining_pending: pending.length,
      }));
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.code(404).send(error('NOT_FOUND', err.message));
      }
      reply.code(500).send(error('INTERNAL_ERROR', err.message));
    }
  });
}
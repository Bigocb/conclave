/**
 * Conclave — Spot-check routes (human calibration)
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { SpotCheckSchema } from '../schemas/index.js';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { success, error } from '../utils/response.js';
import { BudgetService, BUDGET } from '../services/budget.js';
import { randomUUID } from 'crypto';

export const spotCheckRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  const db = fastify.db;
  const budgetSvc = new BudgetService(db);

  // POST /v1/spot-check
  fastify.post('/spot-check', async (request, reply) => {
    const parsed = SpotCheckSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }
    const data = parsed.data;
    const adminId = (request as any).adminId ?? 'admin';

    await db.insert(schema.spotChecks).values({
      id: `spc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      reviewId: data.review_id,
      adminId,
      accuracy: data.accuracy,
      fairness: data.fairness,
      comment: data.comment ?? null,
      dimensionsOverride: data.dimensions_override ? JSON.stringify(data.dimensions_override) : null,
      createdAt: new Date().toISOString(),
    });

    // #9 Spot-check budget award: if accuracy ≥ 4 (1-5 scale), award +8 to the reviewer's principal
    if (data.accuracy >= 4) {
      const reviewRows = await db.select().from(schema.reviews)
        .where(eq(schema.reviews.id, data.review_id)).limit(1);
      if (reviewRows.length > 0) {
        await budgetSvc.earn(reviewRows[0].principalId, BUDGET.SPOT_CHECK_ACCURATE, 'spot_check_accurate', data.review_id);
      }
    }

    reply.code(201).send(success({ review_id: data.review_id, accuracy: data.accuracy, fairness: data.fairness }));
  });

  // GET /v1/spot-check/candidates
  fastify.get('/spot-check/candidates', async (request: any, reply) => {
    const count = parseInt((request.query as any).count ?? '5');
    // Return random recent reviews for spot-checking
    const reviews = await db.select().from(schema.reviews).limit(count);
    const tasks = await db.select().from(schema.tasks).limit(count);

    const candidates = reviews.map(r => ({
      review_id: r.id,
      task_id: r.taskId,
      reviewer_id: r.reviewerId,
      scores: JSON.parse(r.scores),
      comment: r.comment,
      approved: r.approved === 1,
      created_at: r.createdAt,
    }));

    reply.send(success({ candidates }));
  });

  done();
};

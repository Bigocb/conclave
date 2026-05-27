/**
 * Conclave — Push Notification routes
 * Stores Web Push subscriptions for sending notifications
 * to PWA users about pending approvals, task completions, etc.
 */

import { FastifyInstance } from 'fastify';

export async function pushRoutes(fastify: FastifyInstance) {
  const db = (fastify as any).db;

  // POST /v1/push/subscribe — save a push subscription
  fastify.post('/push/subscribe', async (request, reply) => {
    const agentId = (request as any).agentId ?? 'agt_dev';
    const { subscription } = request.body as any;

    if (!subscription || typeof subscription !== 'string') {
      return reply.code(422).send({ status: 'error', error: { code: 'VALIDATION_ERROR', message: 'subscription string is required' } });
    }

    try {
      // Use raw SQL for upsert — avoids drizzle type complexity
      const existing = await db`
        SELECT id FROM clv_push_subscriptions WHERE agent_id = ${agentId} LIMIT 1
      `;

      if (existing && existing.length > 0) {
        await db`
          UPDATE clv_push_subscriptions SET subscription = ${subscription}, updated_at = NOW() WHERE agent_id = ${agentId}
        `;
      } else {
        const id = `psh_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        await db`
          INSERT INTO clv_push_subscriptions (id, agent_id, subscription, created_at, updated_at)
          VALUES (${id}, ${agentId}, ${subscription}, NOW(), NOW())
        `;
      }

      return reply.send({ status: 'success', data: { subscribed: true } });
    } catch (e: any) {
      console.error('[push] Subscribe failed:', e?.message || e);
      return reply.code(500).send({ status: 'error', error: { code: 'SUBSCRIBE_FAILED', message: 'Failed to save push subscription' } });
    }
  });
}

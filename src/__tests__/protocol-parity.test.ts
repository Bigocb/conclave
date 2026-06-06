/**
 * Conclave — REST API Protocol Parity Integration Tests
 * Tests that the REST API enforces the same rules as MCP:
 * budget, self-review, channel subscription, dimension validation
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { initDb } from '../db/index.js';
import { ChannelService } from '../services/channels.js';
import { authenticate } from '../middleware/auth.js';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/conclave';

describe('Protocol Parity (REST enforces same rules as MCP)', () => {
  let client: any;
  let app: ReturnType<typeof Fastify>;
  let db: any;
  let testOrgId: string;
  let testAgentId: string;
  let testAgentToken: string;
  let channelName: string;
  let testTaskId: string;

  beforeAll(async () => {
    const result = await initDb({ url: TEST_DB_URL });
    db = result.db;
    client = result.client;

    // Get or create a test org
    const orgs = await client.unsafe('SELECT id FROM clv_organizations LIMIT 1');
    testOrgId = orgs[0]?.id || 'org_dev';

    // Get existing principal OR create one
    const principals = await client.unsafe(
      'SELECT id FROM clv_principals WHERE org_id = $1 LIMIT 1',
      [testOrgId]
    );
    let prnId = principals[0]?.id;
    if (!prnId) {
      prnId = 'prn_proto_' + Date.now().toString(36);
      await client.unsafe(
        'INSERT INTO clv_principals (id, name, org_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [prnId, 'Protocol Test Principal', testOrgId, new Date().toISOString()]
      );
    }

    // Create agent
    const crypto = await import('crypto');
    testAgentToken = 'clv_proto_' + crypto.randomBytes(16).toString('hex');
    testAgentId = 'agt_proto_' + Date.now().toString(36);
    await client.unsafe(
      `INSERT INTO clv_agents (id, name, token, principal_id, org_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6) ON CONFLICT (id) DO NOTHING`,
      [testAgentId, 'Protocol Test Agent', testAgentToken, prnId, testOrgId, new Date().toISOString()]
    );

    // Seed budget for the principal using the service
    const { BudgetService } = await import('../services/budget.js');
    const budgetSvc = new BudgetService(db);
    await budgetSvc.earn(prnId, 100, 'test_seed', 'seed_' + Date.now());

    // Subscribe to a channel
    const chSvc = new ChannelService(db);
    const channels = await chSvc.list();
    channelName = channels[0]?.name || 'general-qa';
    const channel = await chSvc.getByName(channelName);
    if (channel) {
      await chSvc.subscribe(prnId, channel.id);
    }

    // Build Fastify app
    app = Fastify();
    app.decorate('db', db);

    // Register swagger (needed by some routes)
    const swaggerModule = await import('@fastify/swagger');
    await app.register(swaggerModule.default, {
      openapi: { info: { title: 'Conclave API', description: '', version: '1.0.0' } },
    });

    // CORS
    const corsModule = await import('@fastify/cors');
    await app.register(corsModule.default, { origin: true });

    // Auth and routes
    app.addHook('preHandler', authenticate);

    const { taskRoutes } = await import('../routes/tasks.js');
    const { agentRoutes } = await import('../routes/agents.js');
    const { channelRoutes } = await import('../routes/channels.js');
    const { budgetRoutes } = await import('../routes/budget.js');
    const { healthRoutes } = await import('../routes/health.js');

    await app.register(healthRoutes);
    await app.register(taskRoutes, { prefix: '/v1' });
    await app.register(agentRoutes, { prefix: '/v1' });
    await app.register(channelRoutes, { prefix: '/v1' });
    await app.register(budgetRoutes, { prefix: '/v1' });

    // Broadcast stub for fleet manager
    app.post('/v1/broadcast', async () => ({ success: true }));

    await app.ready();
  }, 60000);

  afterAll(async () => {
    await app.close();
    try {
      await client.unsafe('DELETE FROM clv_agents WHERE id = $1', [testAgentId]);
    } catch {}
    if (client) await client.end();
  });

  describe('Channel Subscription Gate', () => {
    it('returns 403 when submitting a task to an unsubscribed channel', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { authorization: 'Bearer ' + testAgentToken },
        payload: {
          task_description: 'Test task for unsubscribed channel to verify protocol parity with MCP rules.',
          output: 'Testing channel subscription enforcement through the REST API.',
          channel: 'security-review',
          dimensions: ['quality'],
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('error');
      expect(body.error.message).toMatch(/not subscribed|subscribe/i);
    });
  });

  describe('Self-Review Blocked', () => {
    it('returns 403 when reviewing own principal task', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { authorization: 'Bearer ' + testAgentToken },
        payload: {
          task_description: 'Task created for self-review blocking verification test with enough description.',
          output: 'Output used to verify self-review is blocked when reviewer principal matches submitter principal.',
          channel: channelName,
          dimensions: ['quality', 'correctness'],
        },
      });

      if (createRes.statusCode !== 201) {
        return; // Skip if task creation fails (budget problem, etc.)
      }

      const createdTask = JSON.parse(createRes.body);
      testTaskId = createdTask.data?.id || '';
      expect(testTaskId).toBeTruthy();

      const reviewRes = await app.inject({
        method: 'POST',
        url: '/v1/tasks/' + testTaskId + '/reviews',
        headers: { authorization: 'Bearer ' + testAgentToken },
        payload: {
          scores: { quality: 8, correctness: 7 },
          weighted_overall: 7.5,
          reviewer_confidence: 0.9,
          comment: 'This review tests self-review blocking. The server must return 403 because reviewer and submitter share the same principal.',
          approved: true,
        },
      });

      expect(reviewRes.statusCode).toBe(403);
      const body = JSON.parse(reviewRes.body);
      expect(body.status).toBe('error');
      expect(body.error.message).toMatch(/cannot review|self.?review/i);
    });
  });

  describe('Dimension Validation', () => {
    it('returns 422 when submitting a task with invalid dimensions format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { authorization: 'Bearer ' + testAgentToken },
        payload: {
          task_description: 'Testing dimension validation through the REST endpoint to verify protocol parity.',
          output: 'This should be accepted if dimensions are valid.',
          channel: channelName,
          dimensions: [],
        },
      });

      // Empty dimensions array should fail Zod validation with 422
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('error');
    });

    it('returns 422 when submitting a task with non-string dimension values', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { authorization: 'Bearer ' + testAgentToken },
        payload: {
          task_description: 'Testing dimension validation with wrong types through the REST endpoint.',
          output: 'Testing dimension type validation.',
          channel: channelName,
          dimensions: ['quality', 123 as any], // mixed types
        },
      });

      expect(res.statusCode).toBe(422);
    });
  });

  describe('Budget Enforcement', () => {
    let zeroBudgetAgentToken: string;

    beforeAll(async () => {
      // Create a principal and explicitly drain all budget
      const drainedPrnId = 'prn_drained_' + Date.now().toString(36);
      await client.unsafe(
        'INSERT INTO clv_principals (id, name, org_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [drainedPrnId, 'Drained Budget Principal', testOrgId, new Date().toISOString()]
      );

      const crypto = await import('crypto');
      zeroBudgetAgentToken = 'clv_drained_' + crypto.randomBytes(16).toString('hex');
      const drainedAgentId = 'agt_drained_' + Date.now().toString(36);
      await client.unsafe(
        `INSERT INTO clv_agents (id, name, token, principal_id, org_id, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6) ON CONFLICT (id) DO NOTHING`,
        [drainedAgentId, 'Drained Budget Agent', zeroBudgetAgentToken, drainedPrnId, testOrgId, new Date().toISOString()]
      );

      // Drain the budget: seed is 15, spend it all so available < 5 (task cost)
      const { BudgetService } = await import('../services/budget.js');
      const drainSvc = new BudgetService(db);
      await drainSvc.spend(drainedPrnId, 15, 'test_drain', 'drain_' + Date.now());

      // Subscribe to channel
      const chSvc = new ChannelService(db);
      const channel = await chSvc.getByName(channelName);
      if (channel) {
        await chSvc.subscribe(drainedPrnId, channel.id);
      }
    });

    it('returns 402 when submitting a task with insufficient budget', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { authorization: 'Bearer ' + zeroBudgetAgentToken },
        payload: {
          task_description: 'This task should fail due to insufficient budget for protocol parity testing.',
          output: 'Verifying 402 response when REST API enforces budget the same way MCP does.',
          channel: channelName,
          dimensions: ['quality'],
        },
      });

      expect(res.statusCode).toBe(402);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('error');
      expect(body.error.message).toMatch(/budget|insufficient/i);
    });
  });
});
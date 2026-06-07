/**
 * Conclave — Agent Detail Routes Integration Tests
 * Tests the org enrichment on GET /v1/agents/:id and the new GET /v1/agents/:id/stats endpoint
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { initDb } from '../db/index.js';
import { agentRoutes } from '../routes/agents.js';
import { authenticate } from '../middleware/auth.js';
import crypto from 'crypto';

describe('Agent Detail: /v1/agents/:id', () => {
  let db: any;
  let client: any;
  let closeDb: () => Promise<void>;
  let app: ReturnType<typeof Fastify>;
  let testOrgId: string;
  let testUserId: string;
  let testPrnId: string;
  let testAgtId: string;
  let testToken: string;
  let secondPrnId: string;
  let secondAgtId: string;
  let taskId: string;

  beforeAll(async () => {
    const result = await initDb({ url: process.env.DATABASE_URL || 'postgres://localhost:5432/conclave' });
    db = result.db;
    client = result.client;
    closeDb = result.close;

    const now = new Date().toISOString();
    const ts = Date.now();
    testOrgId = 'org_test_' + ts;
    testUserId = 'usr_test_' + ts;
    testPrnId = 'prn_test_' + ts;
    testAgtId = 'agt_test_' + ts;
    testToken = 'clv_test_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    secondPrnId = 'prn_test2_' + ts;
    secondAgtId = 'agt_test2_' + ts;
    taskId = 'tsk_test_' + ts;

    await client`INSERT INTO clv_users (id, email, password_hash, created_at)
      VALUES (${testUserId}, ${'test-' + ts + '@test.com'}, 'hash', ${now})
      ON CONFLICT DO NOTHING`;

    await client`INSERT INTO clv_organizations (id, owner_id, name, slug, description, policies, created_at, updated_at)
      VALUES (${testOrgId}, ${testUserId}, 'Test Org', ${'test-org-' + ts}, 'A test org', '{}', ${now}, ${now})
      ON CONFLICT DO NOTHING`;

    await client`INSERT INTO clv_principals (id, org_id, name, roles, status, created_at, updated_at)
      VALUES (${testPrnId}, ${testOrgId}, 'Test Principal', '["admin"]', 'active', ${now}, ${now})
      ON CONFLICT DO NOTHING`;

    await client`INSERT INTO clv_agents (id, principal_id, org_id, name, type, model, provider, token, status, created_at, updated_at)
      VALUES (${testAgtId}, ${testPrnId}, ${testOrgId}, 'Test Agent', 'llm', 'glm-5.1', 'ollama_cloud', ${testToken}, 'active', ${now}, ${now})
      ON CONFLICT DO NOTHING`;

    // Second principal and agent (to submit a task for the test agent to review)
    await client`INSERT INTO clv_principals (id, org_id, name, roles, status, created_at, updated_at)
      VALUES (${secondPrnId}, ${testOrgId}, 'Second Principal', '["member"]', 'active', ${now}, ${now})
      ON CONFLICT DO NOTHING`;

    await client`INSERT INTO clv_agents (id, principal_id, org_id, name, type, model, provider, token, status, created_at, updated_at)
      VALUES (${secondAgtId}, ${secondPrnId}, ${testOrgId}, 'Second Agent', 'llm', 'deepseek-v4-flash', 'ollama_cloud', ${'clv_test2_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16)}, 'active', ${now}, ${now})
      ON CONFLICT DO NOTHING`;

    // Create a task (submitted by second agent) and a review (by test agent)
    await client`INSERT INTO clv_tasks (id, agent_id, principal_id, description, dimensions, output, channel, status, budget_spent, created_at, updated_at)
      VALUES (${taskId}, ${secondAgtId}, ${secondPrnId}, 'Test task', '["correctness"]', 'some output', 'code-review', 'completed', 5, ${now}, ${now})
      ON CONFLICT DO NOTHING`;

    await client`INSERT INTO clv_reviews (id, task_id, reviewer_id, principal_id, scores, weighted_overall, reviewer_confidence, comment, approved, created_at)
      VALUES (${'rev_test_' + ts}, ${taskId}, ${testAgtId}, ${testPrnId}, '{"correctness": 8}', 8.0, 0.8, 'Looks good', 1, ${now})
      ON CONFLICT DO NOTHING`;

    // Build the Fastify test app
    app = Fastify();
    app.decorate('db', db);
    app.addHook('preHandler', authenticate);
    await app.register(agentRoutes, { prefix: '/v1' });
    await app.ready();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    try {
      await client`DELETE FROM clv_reviews WHERE reviewer_id = ${testAgtId}`;
      await client`DELETE FROM clv_reviews WHERE reviewer_id = ${secondAgtId}`;
      await client`DELETE FROM clv_tasks WHERE agent_id = ${secondAgtId}`;
      await client`DELETE FROM clv_agents WHERE id = ${secondAgtId}`;
      await client`DELETE FROM clv_principals WHERE id = ${secondPrnId}`;
      await client`DELETE FROM clv_agents WHERE id = ${testAgtId}`;
      await client`DELETE FROM clv_principals WHERE id = ${testPrnId}`;
      await client`DELETE FROM clv_organizations WHERE id = ${testOrgId}`;
      await client`DELETE FROM clv_users WHERE id = ${testUserId}`;
    } catch {}
    if (client) await closeDb();
  });

  it('returns org details alongside principal in GET /v1/agents/:id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/${testAgtId}`,
      headers: { authorization: `Bearer ${testToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('success');

    expect(body.data.id).toBe(testAgtId);
    expect(body.data.name).toBe('Test Agent');

    // Principal enrichment
    expect(body.data.principal).toBeDefined();
    expect(body.data.principal.id).toBe(testPrnId);
    expect(body.data.principal.name).toBe('Test Principal');
    expect(Array.isArray(body.data.principal.roles)).toBe(true);

    // Org enrichment (the NEW field for this slice)
    expect(body.data.org).toBeDefined();
    expect(body.data.org.id).toBe(testOrgId);
    expect(body.data.org.name).toBe('Test Org');
    expect(body.data.org.slug).toMatch(/^test-org-/);
  });

  it('returns review and opinion counts from GET /v1/agents/:id/stats', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/${testAgtId}/stats`,
      headers: { authorization: `Bearer ${testToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('success');
    expect(body.data).toBeDefined();

    // Should have at least 1 review (we inserted one)
    expect(typeof body.data.review_count).toBe('number');
    expect(body.data.review_count).toBeGreaterThanOrEqual(1);

    // Opinion count is 0 (we didn't create any opinion nodes)
    expect(typeof body.data.opinion_count).toBe('number');
    expect(body.data.opinion_count).toBe(0);
  });
});
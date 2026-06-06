import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { initDb } from '../db/index.js';
import { ApiKeyService } from '../services/api-keys.js';

describe('api-key-auth-middleware', () => {
  let db: any;
  let client: any;
  let service: ApiKeyService;
  let app: ReturnType<typeof Fastify>;
  let testOrgId: string;

  beforeAll(async () => {
    const result = await initDb({ url: process.env.DATABASE_URL || 'postgres://localhost:5432/conclave' });
    db = result.db;
    client = result.client;

    // Get or create a test org
    const orgs = await client.unsafe(`SELECT id FROM clv_organizations LIMIT 1`);
    testOrgId = orgs[0]?.id || 'org_dev';

    service = new ApiKeyService(db);

    app = Fastify();

    // Register the auth middleware as a global preHandler
    const { authenticate } = await import('../middleware/auth.js');
    app.addHook('preHandler', authenticate);

    // A protected test route
    app.get('/test-auth', async (_req, _reply) => {
      const req = _req as any;
      return {
        orgId: req.orgId,
        apiKeyId: req.apiKeyId,
        permission: req.permission,
        agentId: req.agentId,
        principalId: req.principalId,
      };
    });

    await app.ready();
  }, 60000);

  afterAll(async () => {
    await app.close();
    if (client) await client.end();
  });

  describe('clv_api_ token', () => {
    it('authenticates a valid clv_api_ key and sets orgId, apiKeyId, permission', async () => {
      const { id, plaintextKey } = await service.generateKey(testOrgId, 'Auth Test Key', 'write');

      const res = await app.inject({
        method: 'GET',
        url: '/test-auth',
        headers: { authorization: `Bearer ${plaintextKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.orgId).toBe(testOrgId);
      expect(body.apiKeyId).toBe(id);
      expect(body.permission).toBe('write');

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [id]);
    });

    it('rejects a revoked clv_api_ key with 401', async () => {
      const { id, plaintextKey } = await service.generateKey(testOrgId, 'Revoke Test', 'read');

      // Revoke it
      await service.revokeKey(id, testOrgId);

      const res = await app.inject({
        method: 'GET',
        url: '/test-auth',
        headers: { authorization: `Bearer ${plaintextKey}` },
      });

      expect(res.statusCode).toBe(401);

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [id]);
    });

    it('rejects an unknown clv_api_ key with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test-auth',
        headers: { authorization: 'Bearer clv_api_nonexistent1234567890abcdef' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('clv_ agent token still works', () => {
    it('authenticates a valid clv_ agent token', async () => {
      // Grab any existing agent from the DB
      const agents = await client.unsafe(`SELECT id, token, principal_id, org_id FROM clv_agents LIMIT 1`);
      if (agents.length === 0) return; // skip if no agents seeded

      const agent = agents[0];
      const res = await app.inject({
        method: 'GET',
        url: '/test-auth',
        headers: { authorization: `Bearer ${agent.token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.agentId).toBe(agent.id);
      expect(body.orgId).toBe(agent.org_id);
    });
  });
});
/**
 * Conclave — API Key Route Integration Tests
 * Tests the /v1/api-keys Fastify route handlers
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { initDb } from '../db/index.js';
import { ApiKeyService } from '../services/api-keys.js';
import { authenticate } from '../middleware/auth.js';
import { apiKeyRoutes } from '../routes/api-keys.js';

describe('API Key Routes /v1/api-keys', () => {
  let db: any;
  let client: any;
  let service: ApiKeyService;
  let app: ReturnType<typeof Fastify>;
  let testOrgId: string;
  let adminApiKey: string;
  let adminApiKeyId: string;

  beforeAll(async () => {
    const result = await initDb({ url: process.env.DATABASE_URL || 'postgres://localhost:5432/conclave' });
    db = result.db;
    client = result.client;
    service = new ApiKeyService(db);

    // Get or create a test org
    const orgs = await client.unsafe(`SELECT id FROM clv_organizations LIMIT 1`);
    testOrgId = orgs[0]?.id || 'org_dev';

    // Create an admin key to authenticate the management requests
    const adminKey = await service.generateKey(testOrgId, 'Admin Test Key', 'admin');
    adminApiKey = adminKey.plaintextKey;
    adminApiKeyId = adminKey.id;

    // Build a minimal Fastify app with the API key routes
    app = Fastify();
    app.decorate('db', db);
    app.addHook('preHandler', authenticate);
    await app.register(apiKeyRoutes, { prefix: '/v1' });

    // A test-auth route for verifying revoked keys don't authenticate
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
    // Cleanup test admin key
    if (adminApiKeyId) {
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [adminApiKeyId]);
    }
    if (client) await client.end();
  });

  describe('POST /v1/api-keys', () => {
    it('creates a new API key and returns the plaintext key once', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: { authorization: `Bearer ${adminApiKey}` },
        payload: { name: 'My Test Key', permission: 'write' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('success');
      expect(body.data.plaintext_key).toBeDefined();
      expect(body.data.plaintext_key).toMatch(/^clv_api_/);
      expect(body.data.key.id).toBeDefined();
      expect(body.data.key.name).toBe('My Test Key');
      expect(body.data.key.permission).toBe('write');
      expect(body.data.key.key_prefix).toBe(body.data.plaintext_key.slice(0, 8));
      expect(body.data.key.revoked_at).toBeNull();

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [body.data.key.id]);
    });

    it('returns 422 for invalid permission value', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: { authorization: `Bearer ${adminApiKey}` },
        payload: { name: 'Bad Key', permission: 'superadmin' },
      });

      expect(res.statusCode).toBe(422);
    });

    it('returns 422 for missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: { authorization: `Bearer ${adminApiKey}` },
        payload: { permission: 'read' },
      });

      expect(res.statusCode).toBe(422);
    });

    it('returns 403 when called with a read permission key', async () => {
      const readKey = await service.generateKey(testOrgId, 'Read Only Key', 'read');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: { authorization: `Bearer ${readKey.plaintextKey}` },
        payload: { name: 'Should Fail', permission: 'read' },
      });

      expect(res.statusCode).toBe(403);

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [readKey.id]);
    });
  });

  describe('GET /v1/api-keys', () => {
    it('lists active API keys for the org (excluding revoked)', async () => {
      // Create a couple keys
      const k1 = await service.generateKey(testOrgId, 'List Test 1', 'read');
      const k2 = await service.generateKey(testOrgId, 'List Test 2', 'write');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/api-keys',
        headers: { authorization: `Bearer ${adminApiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('success');
      expect(Array.isArray(body.data.keys)).toBe(true);
      const ids = body.data.keys.map((k: any) => k.id);
      expect(ids).toContain(k1.id);
      expect(ids).toContain(k2.id);

      // Verify keys are masked — no full keyhash in response
      for (const k of body.data.keys) {
        expect(k.key_hash).toBeUndefined();
        expect(k.key_prefix).toBeDefined();
        expect(k.key_prefix.length).toBe(8);
      }

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id IN ($1, $2)`, [k1.id, k2.id]);
    });

    it('does not return revoked keys', async () => {
      const k = await service.generateKey(testOrgId, 'Revoke List Test', 'read');
      await service.revokeKey(k.id, testOrgId);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/api-keys',
        headers: { authorization: `Bearer ${adminApiKey}` },
      });

      const body = JSON.parse(res.body);
      const ids = body.data.keys.map((k: any) => k.id);
      expect(ids).not.toContain(k.id);

      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [k.id]);
    });
  });

  describe('GET /v1/api-keys/:id', () => {
    it('returns a single API key by ID', async () => {
      const k = await service.generateKey(testOrgId, 'Get Single Test', 'admin');

      const res = await app.inject({
        method: 'GET',
        url: `/v1/api-keys/${encodeURIComponent(k.id)}`,
        headers: { authorization: `Bearer ${adminApiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('success');
      expect(body.data.key.id).toBe(k.id);
      expect(body.data.key.name).toBe('Get Single Test');
      expect(body.data.key.permission).toBe('admin');
      expect(body.data.key.key_prefix).toBeDefined();
      expect(body.data.key.key_hash).toBeUndefined();

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [k.id]);
    });

    it('returns 404 for non-existent key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/api-keys/clv_api_nonexistent1234567890abcdef',
        headers: { authorization: `Bearer ${adminApiKey}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /v1/api-keys/:id', () => {
    it('revokes an API key (soft delete)', async () => {
      const k = await service.generateKey(testOrgId, 'Delete Test', 'read');

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/api-keys/${encodeURIComponent(k.id)}`,
        headers: { authorization: `Bearer ${adminApiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('success');
      expect(body.data.revoked).toBe(true);

      // Verify key no longer authenticates
      const authRes = await app.inject({
        method: 'GET',
        url: '/test-auth',
        headers: { authorization: `Bearer ${k.plaintextKey}` },
      });
      expect(authRes.statusCode).toBe(401);

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [k.id]);
    });

    it('returns 404 for non-existent key', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/api-keys/clv_api_nonexistent',
        headers: { authorization: `Bearer ${adminApiKey}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 403 when called with a write permission key', async () => {
      const writeKey = await service.generateKey(testOrgId, 'Write Only Key', 'write');

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/api-keys/${encodeURIComponent(writeKey.id)}`,
        headers: { authorization: `Bearer ${writeKey.plaintextKey}` },
        payload: {},
      });

      expect(res.statusCode).toBe(403);

      // Cleanup the write key
      await service.revokeKey(writeKey.id, testOrgId);
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [writeKey.id]);
    });
  });
});
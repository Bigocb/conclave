import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { initDb } from '../db/index.js';
import { ApiKeyService } from '../services/api-keys.js';

describe('requirePermission', () => {
  let db: any;
  let client: any;
  let service: ApiKeyService;
  let testOrgId: string;
  let adminKey: string;
  let writeKey: string;
  let readKey: string;

  beforeAll(async () => {
    const result = await initDb({ url: process.env.DATABASE_URL || 'postgres://localhost:5432/conclave' });
    db = result.db;
    client = result.client;

    const orgs = await client.unsafe(`SELECT id FROM clv_organizations LIMIT 1`);
    testOrgId = orgs[0]?.id || 'org_dev';

    service = new ApiKeyService(db);

    // Create one key per permission level
    const admin = await service.generateKey(testOrgId, 'Admin Key', 'admin');
    adminKey = admin.plaintextKey;
    const write = await service.generateKey(testOrgId, 'Write Key', 'write');
    writeKey = write.plaintextKey;
    const read = await service.generateKey(testOrgId, 'Read Key', 'read');
    readKey = read.plaintextKey;
  }, 60000);

  afterAll(async () => {
    if (client) await client.end();
  });

  async function buildApp() {
    const { authenticate, requirePermission } = await import('../middleware/auth.js');

    const app = Fastify();
    app.addHook('preHandler', authenticate);

    // An admin-only route (like managing API keys)
    app.get('/admin-only', {
      preHandler: [requirePermission('admin')],
    }, async (_req) => ({ ok: true }));

    // A write-level route (like submitting tasks)
    app.post('/write-only', {
      preHandler: [requirePermission('write')],
    }, async (_req) => ({ ok: true }));

    // A read-level route (like viewing tasks)
    app.get('/read-allowed', {
      preHandler: [requirePermission('read')],
    }, async (_req) => ({ ok: true }));

    await app.ready();
    return app;
  }

  describe('admin permission', () => {
    it('grants access to admin-only routes', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      await app.close();
      expect(res.statusCode).toBe(200);
    });

    it('grants access to write-level routes', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/write-only',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      await app.close();
      expect(res.statusCode).toBe(200);
    });

    it('grants access to read-level routes', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/read-allowed',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      await app.close();
      expect(res.statusCode).toBe(200);
    });
  });

  describe('write permission', () => {
    it('denies access to admin-only routes with 403', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: { authorization: `Bearer ${writeKey}` },
      });
      await app.close();
      expect(res.statusCode).toBe(403);
    });

    it('grants access to write-level routes', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/write-only',
        headers: { authorization: `Bearer ${writeKey}` },
      });
      await app.close();
      expect(res.statusCode).toBe(200);
    });

    it('grants access to read-level routes', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/read-allowed',
        headers: { authorization: `Bearer ${writeKey}` },
      });
      await app.close();
      expect(res.statusCode).toBe(200);
    });
  });

  describe('read permission', () => {
    it('denies access to admin-only routes with 403', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: { authorization: `Bearer ${readKey}` },
      });
      await app.close();
      expect(res.statusCode).toBe(403);
    });

    it('denies access to write-level routes with 403', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/write-only',
        headers: { authorization: `Bearer ${readKey}` },
      });
      await app.close();
      expect(res.statusCode).toBe(403);
    });

    it('grants access to read-level routes', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/read-allowed',
        headers: { authorization: `Bearer ${readKey}` },
      });
      await app.close();
      expect(res.statusCode).toBe(200);
    });
  });

  describe('agent token (no permission set)', () => {
    it('is treated as admin by default', async () => {
      const agents = await client.unsafe(`SELECT token FROM clv_agents LIMIT 1`);
      if (agents.length === 0) return;

      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: { authorization: `Bearer ${agents[0].token}` },
      });
      await app.close();
      expect(res.statusCode).toBe(200);
    });
  });

  describe('no auth', () => {
    it('returns 401 when no auth header is present', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/read-allowed',
      });
      await app.close();
      expect(res.statusCode).toBe(401);
    });
  });
});
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb } from '../db/index.js';
import { ApiKeyService } from '../services/api-keys.js';

describe('ApiKeyService', () => {
  let db: any;
  let client: any;
  let service: ApiKeyService;
  let testOrgId: string;

  beforeAll(async () => {
    const result = await initDb({ url: process.env.DATABASE_URL || 'postgres://localhost:5432/conclave' });
    db = result.db;
    client = result.client;

    // Get or create a test org
    try {
      const orgs = await client.unsafe(`SELECT id FROM clv_organizations LIMIT 1`);
      testOrgId = orgs[0]?.id || 'org_dev';
    } catch {
      testOrgId = 'org_dev';
    }

    service = new ApiKeyService(db);
  }, 60000);

  afterAll(async () => {
    if (client) await client.end();
  });

  describe('generateKey', () => {
    it('returns a plaintext key starting with clv_api_', async () => {
      const result = await service.generateKey(testOrgId, 'Test Key', 'read');

      expect(result.plaintextKey).toBeDefined();
      expect(result.plaintextKey).toMatch(/^clv_api_/);

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [result.id]);
    });

    it('stores the key hash in the database', async () => {
      const result = await service.generateKey(testOrgId, 'Hash Test', 'write');
      const stored = await client.unsafe(`SELECT key_hash, key_prefix, permission, org_id FROM clv_api_keys WHERE id = $1`, [result.id]);

      expect(stored.length).toBe(1);
      expect(stored[0].key_hash).toBeDefined();
      expect(stored[0].key_hash).not.toBe(result.plaintextKey); // hash != plaintext
      expect(stored[0].key_prefix).toBe(result.plaintextKey.slice(0, 8));
      expect(stored[0].permission).toBe('write');
      expect(stored[0].org_id).toBe(testOrgId);

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [result.id]);
    });

    it('generates a unique key each time', async () => {
      const r1 = await service.generateKey(testOrgId, 'Key 1', 'read');
      const r2 = await service.generateKey(testOrgId, 'Key 2', 'read');

      expect(r1.plaintextKey).not.toBe(r2.plaintextKey);
      expect(r1.id).not.toBe(r2.id);

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id IN ($1, $2)`, [r1.id, r2.id]);
    });
  });

  describe('lookupKey', () => {
    it('returns key record for a valid key', async () => {
      const { id, plaintextKey } = await service.generateKey(testOrgId, 'Lookup Test', 'admin');

      const found = await service.lookupKey(plaintextKey);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
      expect(found!.orgId).toBe(testOrgId);
      expect(found!.name).toBe('Lookup Test');
      expect(found!.permission).toBe('admin');
      expect(found!.keyHash).toBeDefined();
      expect(found!.revokedAt).toBeNull();

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [id]);
    });

    it('returns null for an unknown key', async () => {
      const result = await service.lookupKey('clv_api_unknownkey123');
      expect(result).toBeNull();
    });

    it('returns null for a revoked key', async () => {
      const { id, plaintextKey } = await service.generateKey(testOrgId, 'Revoke Test', 'read');

      // Revoke it directly
      await client.unsafe(`UPDATE clv_api_keys SET revoked_at = $1 WHERE id = $2`, [new Date().toISOString(), id]);

      const found = await service.lookupKey(plaintextKey);
      expect(found).toBeNull();

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [id]);
    });
  });

  describe('listKeys', () => {
    it('returns all keys for an org', async () => {
      // Create two keys
      const k1 = await service.generateKey(testOrgId, 'List Key 1', 'read');
      const k2 = await service.generateKey(testOrgId, 'List Key 2', 'write');

      const keys = await service.listKeys(testOrgId);

      expect(keys.length).toBeGreaterThanOrEqual(2);
      const found1 = keys.find(k => k.id === k1.id);
      const found2 = keys.find(k => k.id === k2.id);
      expect(found1).toBeDefined();
      expect(found1!.name).toBe('List Key 1');
      expect(found1!.keyPrefix).toBe(k1.plaintextKey.slice(0, 8));
      expect(found1!.permission).toBe('read');
      expect(found2).toBeDefined();
      expect(found2!.name).toBe('List Key 2');

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id IN ($1, $2)`, [k1.id, k2.id]);
    });

    it('returns keys scoped to the correct org', async () => {
      // Create a user + second org in DB for cross-org scoping test
      const otherUserId = `usr_test_${Date.now()}`;
      const otherOrgId = `org_test_${Date.now()}`;
      await client.unsafe(
        `INSERT INTO clv_users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [otherUserId, `${otherUserId}@test.com`, 'hash', new Date().toISOString()]
      );
      await client.unsafe(
        `INSERT INTO clv_organizations (id, name, slug, owner_id, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [otherOrgId, 'Other Test Org', `other-${Date.now()}`, otherUserId, new Date().toISOString()]
      );

      const k1 = await service.generateKey(testOrgId, 'My Key', 'read');
      const k2 = await service.generateKey(otherOrgId, 'Other Key', 'read');

      const myKeys = await service.listKeys(testOrgId);
      const myIds = myKeys.map(k => k.id);
      expect(myIds).toContain(k1.id);
      expect(myIds).not.toContain(k2.id);

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id IN ($1, $2)`, [k1.id, k2.id]);
      await client.unsafe(`DELETE FROM clv_organizations WHERE id = $1`, [otherOrgId]);
      await client.unsafe(`DELETE FROM clv_users WHERE id = $1`, [otherUserId]);
    });

    it('returns only non-revoked keys', async () => {
      const k1 = await service.generateKey(testOrgId, 'Active Key', 'read');
      await service.revokeKey(k1.id, testOrgId);

      const keys = await service.listKeys(testOrgId);
      const activeIds = keys.map(k => k.id);
      expect(activeIds).not.toContain(k1.id);
    });
  });

  describe('revokeKey', () => {
    it('sets revoked_at on the key', async () => {
      const { id, plaintextKey } = await service.generateKey(testOrgId, 'To Revoke', 'read');

      await service.revokeKey(id, testOrgId);

      // Verify revoked
      const found = await service.lookupKey(plaintextKey);
      expect(found).toBeNull();

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [id]);
    });

    it('throws when revoking a key from a different org context', async () => {
      const { id } = await service.generateKey(testOrgId, 'Org Mismatch', 'read');

      // construct like the route would — passing a different orgId
      await expect(service.revokeKey(id, 'org_different_context')).rejects.toThrow();

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [id]);
    });

    it('is idempotent when called multiple times', async () => {
      const { id } = await service.generateKey(testOrgId, 'Double Revoke', 'read');

      await service.revokeKey(id, testOrgId);
      await service.revokeKey(id, testOrgId); // should not throw

      const row = await client.unsafe(`SELECT revoked_at FROM clv_api_keys WHERE id = $1`, [id]);
      expect(row[0].revoked_at).toBeDefined();

      // Cleanup
      await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [id]);
    });
  });
});
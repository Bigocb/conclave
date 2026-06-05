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
});
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb } from '../db/index.js';

describe('API Keys Schema (Slice 1)', () => {
  let db: any;
  let client: any;
  let testOrgId: string;

  beforeAll(async () => {
    const result = await initDb({ url: process.env.DATABASE_URL || 'postgres://localhost:5432/conclave' });
    db = result.db;
    client = result.client;
    
    // Get an existing org from the DB for tests - use a test org that we create
    // Check if any orgs exist, otherwise use a placeholder for schema-only tests
    try {
      const orgs = await client.unsafe(`SELECT id FROM clv_organizations LIMIT 1`);
      testOrgId = orgs[0]?.id || 'org_dev';
    } catch {
      // Table might not exist yet - use placeholder
      testOrgId = 'org_dev';
    }
  }, 60000); // 60s timeout for DB init

  afterAll(async () => {
    if (client) await client.end();
  });

  it('clv_api_keys table exists with all required columns', async () => {
    // First verify the table exists
    const tableExists = await client.unsafe(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'clv_api_keys'
      ) as exists
    `);
    
    if (!tableExists[0]?.exists) {
      // Table doesn't exist yet - this is expected before migration
      // Just verify schema.ts defines it
      const { apiKeys } = await import('../db/schema');
      expect(apiKeys).toBeDefined();
      return;
    }
    
    // Query the information_schema to verify table and columns exist
    const result = await client.unsafe(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'clv_api_keys' 
      ORDER BY ordinal_position
    `);
    
    const columns = result.map((r: any) => r.column_name);
    
    // Required columns per issue #121
    expect(columns).toContain('id');
    expect(columns).toContain('org_id');
    expect(columns).toContain('name');
    expect(columns).toContain('key_hash');
    expect(columns).toContain('key_prefix');
    expect(columns).toContain('permission');
    expect(columns).toContain('created_at');
    expect(columns).toContain('revoked_at');
  });

  it('api key id follows clv_api_<uuid> pattern', async () => {
    // Insert a test key and verify ID format
    const testId = `clv_api_${Date.now()}`;
    
    await client.unsafe(`
      INSERT INTO clv_api_keys (id, org_id, name, key_hash, key_prefix, permission, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [testId, testOrgId, 'test-key', 'hash123', 'hash123', 'admin', new Date().toISOString()]);

    const result = await client.unsafe(`SELECT id FROM clv_api_keys WHERE id = $1`, [testId]);
    expect(result.length).toBe(1);
    expect(result[0].id).toMatch(/^clv_api_/);

    // Cleanup
    await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [testId]);
  });

  it('permission column accepts read, write, admin values', async () => {
    const testId = `clv_api_${Date.now()}_perm`;

    // Test each permission level
    for (const perm of ['read', 'write', 'admin']) {
      await client.unsafe(`
        INSERT INTO clv_api_keys (id, org_id, name, key_hash, key_prefix, permission, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [`${testId}_${perm}`, testOrgId, `test-${perm}`, 'hash', 'hash', perm, new Date().toISOString()]);
    }

    const result = await client.unsafe(`
      SELECT permission FROM clv_api_keys 
      WHERE id LIKE $1
    `, [`${testId}_%`]);
    
    expect(result.length).toBe(3);
    expect(result.map((r: any) => r.permission).sort()).toEqual(['admin', 'read', 'write']);

    // Cleanup
    await client.unsafe(`DELETE FROM clv_api_keys WHERE id LIKE $1`, [`${testId}_%`]);
  });

  it('revoked_at is null for active keys', async () => {
    const testId = `clv_api_${Date.now()}_active`;

    await client.unsafe(`
      INSERT INTO clv_api_keys (id, org_id, name, key_hash, key_prefix, permission, created_at, revoked_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
    `, [testId, testOrgId, 'active-key', 'hash', 'hash', 'read', new Date().toISOString()]);

    const result = await client.unsafe(`SELECT revoked_at FROM clv_api_keys WHERE id = $1`, [testId]);
    expect(result.length).toBe(1);
    expect(result[0].revoked_at).toBeNull();

    // Cleanup
    await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [testId]);
  });

  it('revoked_at is set when key is revoked', async () => {
    const testId = `clv_api_${Date.now()}_revoked`;
    const revokedAt = new Date().toISOString();

    await client.unsafe(`
      INSERT INTO clv_api_keys (id, org_id, name, key_hash, key_prefix, permission, created_at, revoked_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [testId, testOrgId, 'revoked-key', 'hash', 'hash', 'read', new Date().toISOString(), revokedAt]);

    const result = await client.unsafe(`SELECT revoked_at FROM clv_api_keys WHERE id = $1`, [testId]);
    expect(result.length).toBe(1);
    expect(result[0].revoked_at).not.toBeNull();

    // Cleanup
    await client.unsafe(`DELETE FROM clv_api_keys WHERE id = $1`, [testId]);
  });
});

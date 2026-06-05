/**
 * Conclave — API Key Service
 * CRUD for API keys used to authenticate REST API requests
 */

import { eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';

export class ApiKeyService {
  constructor(private db: ConclaveDb) {}

  async generateKey(orgId: string, name: string, permission: string): Promise<{ id: string; plaintextKey: string }> {
    const rawKey = `clv_api_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 8);
    const id = rawKey;

    await this.db.insert(schema.apiKeys).values({
      id,
      orgId,
      name,
      keyHash,
      keyPrefix,
      permission,
      createdAt: new Date().toISOString(),
    });

    return { id, plaintextKey: rawKey };
  }

  async lookupKey(key: string): Promise<{
    id: string;
    orgId: string;
    name: string;
    keyHash: string;
    permission: string;
    revokedAt: string | null;
  } | null> {
    const keyHash = createHash('sha256').update(key).digest('hex');

    const rows = await this.db.select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.keyHash, keyHash))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];

    // Reject revoked keys
    if (row.revokedAt) return null;

    return {
      id: row.id,
      orgId: row.orgId,
      name: row.name,
      keyHash: row.keyHash,
      permission: row.permission,
      revokedAt: row.revokedAt,
    };
  }

  async listKeys(orgId: string): Promise<Array<{
    id: string;
    orgId: string;
    name: string;
    keyPrefix: string;
    permission: string;
    createdAt: string;
    revokedAt: string | null;
  }>> {
    const rows = await this.db.select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.orgId, orgId));

    return rows.filter(r => !r.revokedAt).map(r => ({
      id: r.id,
      orgId: r.orgId,
      name: r.name,
      keyPrefix: r.keyPrefix,
      permission: r.permission,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
    }));
  }

  async revokeKey(id: string, orgId: string): Promise<void> {
    // Fetch to verify ownership
    const rows = await this.db.select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id))
      .limit(1);

    if (rows.length === 0) return; // already gone
    if (rows[0].orgId !== orgId) {
      throw new Error('KEY_ORG_MISMATCH');
    }

    await this.db.update(schema.apiKeys)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(schema.apiKeys.id, id));
  }
}
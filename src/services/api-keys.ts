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
}
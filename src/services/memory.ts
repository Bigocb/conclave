import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { principalMemory } from '../db/schema.js';
import * as crypto from 'crypto';

export interface MemoryEntry {
  id: string;
  principalId: string;
  key: string;
  value: string;
  category: string;
  updatedAt: string;
}

export class MemoryService {
  constructor(private db: NodePgDatabase<any>) {}

  async getByPrincipal(principalId: string) {
    return await this.db.select().from(principalMemory)
      .where(eq(principalMemory.principalId, principalId));
  }

  async getByKey(principalId: string, key: string) {
    const results = await this.db.select().from(principalMemory)
      .where(and(
        eq(principalMemory.principalId, principalId),
        eq(principalMemory.key, key)
      )).limit(1);
    return results[0];
  }

  async upsert(data: {
    principalId: string;
    key: string;
    value: string;
    category?: string;
  }) {
    const existing = await this.getByKey(data.principalId, data.key);
    
    if (existing) {
      await this.db.update(principalMemory)
        .set({
          value: data.value,
          category: data.category ?? existing.category,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(principalMemory.id, existing.id));
      
      return { ...existing, value: data.value, updatedAt: new Date().toISOString() };
    }

    const id = `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await this.db.insert(principalMemory).values({
      id,
      principalId: data.principalId,
      key: data.key,
      value: data.value,
      category: data.category ?? 'general',
    });

    return {
      id,
      principalId: data.principalId,
      key: data.key,
      value: data.value,
      category: data.category ?? 'general',
      updatedAt: new Date().toISOString(),
    };
  }

  async delete(principalId: string, key: string) {
    const existing = await this.getByKey(principalId, key);
    if (!existing) return false;
    
    await this.db.delete(principalMemory)
      .where(eq(principalMemory.id, existing.id));
    return true;
  }
}

import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { principalMemory } from '../db/schema.js';
import * as crypto from 'crypto';

export interface MemoryEntry {
  id: string;
  principalId: string;
  key: string;
  value: string;
  category: string | null;
  expiresAt: string | null;
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
    expiresAt?: string | null;
  }) {
    const existing = await this.getByKey(data.principalId, data.key);
    
    if (existing) {
      await this.db.update(principalMemory)
        .set({
          value: data.value,
          category: data.category ?? existing.category,
          expiresAt: data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(principalMemory.id, existing.id));
      
      return { ...existing, value: data.value, expiresAt: data.expiresAt ?? existing.expiresAt, updatedAt: new Date().toISOString() };
    }

    const id = `mem_${crypto.randomUUID().replace(/-/g own, '').slice(0, 24)}`;
    await this.db.insert(principalMemory).values({
      id,
      principalId: data.principalId,
      key: data.key,
      value: data.value,
      category: data.category ?? 'general',
      expiresAt: data.expiresAt ?? null,
    });

    return {
      id,
      principalId: data.principalId,
      key: data.key,
      value: data.value,
      category: data.category ?? 'general',
      expiresAt: data.expiresAt ?? null,
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

  async search(principalId: string, query: string, limit = 20) {
    if (!query || query.trim().length < 2) {
      return [];
    }
    
    const q = query.toLowerCase();
    const memories = await this.getByPrincipal(principalId);
    
    const results = memories.filter(m => 
      m.key?.toLowerCase().includes(q) ||
      m.value?.toLowerCase().includes(q) ||
      m.category?.toLowerCase().includes(q)
    );
    
    results.sort((a, b) => {
      const aKey = a.key?.toLowerCase().includes(q) ? 0 : 1;
      const bKey = b.key?.toLowerCase().includes(q) ? 0 : 1;
      if (aKey !== bKey) return aKey - bKey;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    
    return results.slice(0, limit);
  }

  async cleanupExpired() {
    const now = new Date().toISOString();
    const rawResult = await (this.db as any).execute(
      `DELETE FROM clv_principal_memory WHERE expires_at IS NOT NULL AND expires_at < '${now}'`
    );
    return rawResult.rowCount || 0;
  }

  async getStats(principalId: string) {
    const memories = await this.getByPrincipal(principalId);
    const total = memories.length;
    const categories: Record<string, number> = {};
    memories.forEach(m => {
      const cat = m.category || 'general';
      categories[cat] = (categories[cat] || 0) + 1;
    });
    return { total, categories };
  }
}

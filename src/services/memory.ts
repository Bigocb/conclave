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
    expiresAt?: string | null;  // ISO timestamp, null = never expires
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

    const id = `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
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

  /**
   * Search memories by query string using ILIKE pattern matching.
   * Searches in key, value, and category fields.
   * Issue #77 - Semantic memory search
   */
  async search(principalId: string, query: string, limit = 20) {
    if (!query || query.trim().length < 2) {
      return [];
    }
    
    const pattern = `%${query.toLowerCase()}%`;
    
    // Get all memories for principal and filter in-memory (ILIKE not in drizzle-orm yet)
    const memories = await this.db.select().from(principalMemory)
      .where(eq(principalMemory.principalId, principalId));
    
    // Filter by pattern match on key, value, or category
    const q = query.toLowerCase();
    const results = memories.filter(m => 
      m.key.toLowerCase().includes(q) ||
      m.value.toLowerCase().includes(q) ||
      m.category.toLowerCase().includes(q)
    );
    
    // Sort by relevance (key match > value match > category match)
    results.sort((a, b) => {
      const aKey = a.key.toLowerCase().includes(q) ? 0 : 1;
      const bKey = b.key.toLowerCase().includes(q) ? 0 : 1;
      if (aKey !== bKey) return aKey - bKey;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    
    return results.slice(0, limit);
  }

  /**
   * Cleanup expired memories (TTL expiry).
   * Issue #78 - Memory decay with TTL
   */
  async cleanupExpired() {
    const now = new Date().toISOString();
    
    // Use raw query for cross-DB compatibility
    const rawResult = await (this.db as any).execute(
      `DELETE FROM clv_principal_memory WHERE expires_at IS NOT NULL AND expires_at < '${now}'`
    );
    
    return rawResult.rowCount || 0;
  }
}

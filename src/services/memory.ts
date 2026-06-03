import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, like, ilike, or, isNull, lt, gt, sql } from 'drizzle-orm';
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
    expiresAt?: string;  // ISO timestamp for TTL-based decay
  }) {
    const existing = await this.getByKey(data.principalId, data.key);
    
    if (existing) {
      await this.db.update(principalMemory)
        .set({
          value: data.value,
          category: data.category ?? existing.category,
          expiresAt: data.expiresAt ?? existing.expiresAt,
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
   * Search memories using ILIKE pattern matching
   * Uses simple text search - matches against key, value, and category
   * Note: ILIKE is NOT semantic search - it's substring/pattern matching.
   * Special chars % and _ are escaped to prevent wildcard injection.
   */
  async search(principalId: string, query: string, options?: {
    category?: string;
    limit?: number;
    includeExpired?: boolean;
  }) {
    const { category, limit = 20, includeExpired = false } = options || {};
    
    // Escape special LIKE characters: % and _ are wildcards
    const escapedQuery = query ? query.replace(/[%_]/g, '\\$&') : '';
    
    // Build conditions
    const conditions: any[] = [eq(principalMemory.principalId, principalId)];
    
    // Add search pattern (ILIKE) with escaped query
    if (escapedQuery) {
      const pattern = `%${escapedQuery}%`;
      conditions.push(
        or(
          ilike(principalMemory.key, pattern),
          ilike(principalMemory.value, pattern)
        )
      );
    }
    
    // Filter by category if provided
    if (category) {
      conditions.push(eq(principalMemory.category, category));
    }
    
    // Filter out expired if not including them
    if (!includeExpired) {
      conditions.push(
        or(
          isNull(principalMemory.expiresAt),
          gt(principalMemory.expiresAt, new Date().toISOString())
        )
      );
    }
    
    const results = await this.db.select().from(principalMemory)
      .where(and(...conditions))
      .limit(limit);
    
    return results;
  }

  /**
   * Cleanup expired memories - returns count deleted
   * Uses raw SQL to avoid Drizzle type issues
   */
  async cleanupExpired(): Promise<number> {
    const now = new Date().toISOString();
    
    // Use raw SQL for this to ensure it works properly
    // This will delete all memories where expires_at is not null and is in the past
    const result = await this.db.execute(
      sql`DELETE FROM clv_principal_memory WHERE expires_at IS NOT NULL AND expires_at < ${now}`
    );
    
    // result.rowCount is available in postgres.js
    return (result as any).rowCount || 0;
  }

  /**
   * Get memory statistics for a principal
   */
  async getStats(principalId: string) {
    const now = new Date().toISOString();
    
    const all = await this.db.select().from(principalMemory)
      .where(eq(principalMemory.principalId, principalId));
    
    const expired = all.filter(m => m.expiresAt && m.expiresAt < now);
    const active = all.filter(m => !m.expiresAt || m.expiresAt >= now);
    
    const byCategory: Record<string, number> = {};
    for (const mem of all) {
      const cat = mem.category || 'general';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
    
    return {
      total: all.length,
      active: active.length,
      expired: expired.length,
      byCategory,
    };
  }
}

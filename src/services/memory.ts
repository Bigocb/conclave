import { ConclaveDb } from '../db/index.js';
import { agentMemory } from '../db/schema.js';
import { eq, and, ilike, desc } from 'drizzle-orm';
import * as crypto from 'crypto';

export interface MemoryFilters {
  principalId: string;
  channel?: string | null;
  keyPrefix?: string;
}

export interface MemoryEntry {
  id: string;
  principalId: string;
  orgId: string;
  channel: string | null;
  key: string;
  value: string;
  category: string;
  sourceTaskId: string | null;
  sourceReviewId: string | null;
  helpfulScore: number;
  createdAt: string;
  updatedAt: string;
}

export class MemoryService {
  constructor(private db: ConclaveDb) {}

  async create(data: {
    principalId: string;
    orgId: string;
    channel?: string | null;
    key: string;
    value: string;
    category?: string;
    sourceTaskId?: string | null;
    sourceReviewId?: string | null;
  }) {
    const id = `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const now = new Date().toISOString();

    const [result] = await this.db.insert(agentMemory).values({
      id,
      principalId: data.principalId,
      orgId: data.orgId,
      channel: data.channel ?? null,
      key: data.key,
      value: data.value,
      category: data.category ?? 'convention',
      sourceTaskId: data.sourceTaskId ?? null,
      sourceReviewId: data.sourceReviewId ?? null,
      createdAt: now,
      updatedAt: now,
    }).returning();

    return result;
  }

  async getForPrincipal(filters: MemoryFilters) {
    const { principalId, channel, keyPrefix } = filters;
    
    const conditions = [eq(agentMemory.principalId, principalId)];
    
    if (channel !== undefined) {
      conditions.push(eq(agentMemory.channel, channel));
    }
    
    if (keyPrefix) {
      conditions.push(ilike(agentMemory.key, `${keyPrefix}%`));
    }

    return await this.db.query.agentMemory.findMany({
      where: and(...conditions),
      orderBy: [desc(agentMemory.helpfulScore), desc(agentMemory.updatedAt)],
    });
  }

  async getById(id: string) {
    return await this.db.query.agentMemory.findFirst({
      where: eq(agentMemory.id, id),
    });
  }

  async update(id: string, data: {
    value?: string;
    helpfulScore?: number;
    category?: string;
  }) {
    const now = new Date().toISOString();
    
    const [result] = await this.db.update(agentMemory)
      .set({ 
        ...data, 
        updatedAt: now 
      })
      .where(eq(agentMemory.id, id))
      .returning();
    
    return result;
  }

  async delete(id: string) {
    const result = await this.db.delete(agentMemory)
      .where(eq(agentMemory.id, id))
      .returning();
    
    return result[0] ?? null;
  }
}

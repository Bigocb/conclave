/**
 * Conclave — Opinion service
 * CRUD operations for opinions and responses
 */

import { eq, and, desc } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';

export class OpinionService {
  constructor(private db: ConclaveDb) {}

  async create(data: {
    id: string;
    agentId: string;
    principalId: string;
    question: string;
    context?: string;
    channel: string;
    requestedOpinions?: number;
    deadline?: string;
    metadata?: Record<string, unknown>;
    budgetSpent?: number;
  }) {
    const now = new Date().toISOString();
    await this.db.insert(schema.opinions).values({
      id: data.id,
      agentId: data.agentId,
      principalId: data.principalId,
      question: data.question,
      context: data.context ?? null,
      channel: data.channel,
      requestedOpinions: data.requestedOpinions ?? 3,
      deadline: data.deadline ?? null,
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      status: 'open',
      topology: 'democratic',
      budgetSpent: data.budgetSpent ?? 3,
      createdAt: now,
    });
    return this.getById(data.id);
  }

  async getById(id: string) {
    const rows = await this.db.select().from(schema.opinions).where(eq(schema.opinions.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.formatOpinion(rows[0]);
  }

  async list(filters: { channel?: string; principalId?: string } = {}) {
    const conditions = [];
    if (filters.channel) conditions.push(eq(schema.opinions.channel, filters.channel));
    if (filters.principalId) conditions.push(eq(schema.opinions.principalId, filters.principalId));

    const rows = conditions.length > 0
      ? await this.db.select().from(schema.opinions).where(and(...conditions)).orderBy(desc(schema.opinions.createdAt)).limit(50)
      : await this.db.select().from(schema.opinions).orderBy(desc(schema.opinions.createdAt)).limit(50);
    return rows.map(r => this.formatOpinion(r));
  }

  async submitResponse(data: {
    id: string;
    opinionId: string;
    respondentId: string;
    principalId: string;
    response: string;
    confidence: number;
    reasoning?: string;
    references?: string[];
    metadata?: Record<string, unknown>;
  }) {
    const now = new Date().toISOString();
    await this.db.insert(schema.opinionResponses).values({
      id: data.id,
      opinionId: data.opinionId,
      respondentId: data.respondentId,
      principalId: data.principalId,
      response: data.response,
      confidence: data.confidence,
      reasoning: data.reasoning ?? null,
      references: data.references ? JSON.stringify(data.references) : null,
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      createdAt: now,
    });
    return this.getResponseById(data.id);
  }

  async getResponseById(id: string) {
    const rows = await this.db.select().from(schema.opinionResponses).where(eq(schema.opinionResponses.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.formatResponse(rows[0]);
  }

  async getResponsesForOpinion(opinionId: string) {
    const rows = await this.db.select().from(schema.opinionResponses).where(eq(schema.opinionResponses.opinionId, opinionId));
    return rows.map(r => this.formatResponse(r));
  }

  private formatOpinion(row: typeof schema.opinions.$inferSelect) {
    return {
      id: row.id,
      agent_id: row.agentId,
      principal_id: row.principalId,
      question: row.question,
      context: row.context,
      channel: row.channel,
      requested_opinions: row.requestedOpinions,
      deadline: row.deadline,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      status: row.status ?? 'open',
      topology: row.topology ?? 'democratic',
      budget_spent: row.budgetSpent,
      created_at: row.createdAt,
    };
  }

  private formatResponse(row: typeof schema.opinionResponses.$inferSelect) {
    return {
      id: row.id,
      opinion_id: row.opinionId,
      respondent_id: row.respondentId,
      principal_id: row.principalId,
      response: row.response,
      confidence: row.confidence,
      reasoning: row.reasoning,
      references: row.references ? JSON.parse(row.references) : [],
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      created_at: row.createdAt,
    };
  }
}
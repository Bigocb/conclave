/**
 * Conclave — Agent service
 * CRUD operations for agents (ephemeral instances)
 */

import { eq, and } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';

export class AgentService {
  constructor(private db: ConclaveDb) {}

  async create(data: {
    id: string;
    principalId: string;
    orgId: string;
    name: string;
    token: string;
    model?: string;
  }) {
    const now = new Date().toISOString();
    await this.db.insert(schema.agents).values({
      id: data.id,
      principalId: data.principalId,
      orgId: data.orgId,
      name: data.name,
      token: data.token,
      model: data.model ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    return this.getById(data.id);
  }

  async getById(id: string) {
    const rows = await this.db.select().from(schema.agents).where(eq(schema.agents.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.formatAgent(rows[0]);
  }

  async getByToken(token: string) {
    const rows = await this.db.select().from(schema.agents).where(eq(schema.agents.token, token)).limit(1);
    if (rows.length === 0) return null;
    return this.formatAgent(rows[0]);
  }

  async update(id: string, data: { name?: string; model?: string }) {
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (data.name) updates.name = data.name;
    if (data.model !== undefined) updates.model = data.model;

    await this.db.update(schema.agents).set(updates).where(eq(schema.agents.id, id));
    return this.getById(id);
  }

  async deactivate(id: string) {
    await this.db.update(schema.agents)
      .set({ status: 'decommissioned', updatedAt: new Date().toISOString() })
      .where(eq(schema.agents.id, id));
  }

  async list(filters: { org?: string; principal?: string; status?: string; page?: number; perPage?: number }) {
    const page = filters.page ?? 1;
    const perPage = filters.perPage ?? 20;
    const offset = (page - 1) * perPage;

    const conditions = [];
    conditions.push(eq(schema.agents.status, filters.status ?? 'active'));
    if (filters.org) {
      conditions.push(eq(schema.agents.orgId, filters.org));
    }
    if (filters.principal) {
      conditions.push(eq(schema.agents.principalId, filters.principal));
    }

    const rows = await this.db.select().from(schema.agents)
      .where(and(...conditions))
      .limit(perPage)
      .offset(offset);
    return rows.map(r => this.formatAgent(r));
  }

  private formatAgent(row: typeof schema.agents.$inferSelect) {
    return {
      id: row.id,
      principal_id: row.principalId,
      org_id: row.orgId,
      name: row.name,
      model: row.model,
      status: row.status,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}
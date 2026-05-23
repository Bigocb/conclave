/**
 * Conclave — Principal service
 * CRUD operations and discovery for principals (durable identities)
 */

import { eq, and } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';

export class PrincipalService {
  constructor(private db: ConclaveDb) {}

  async create(data: {
    id: string;
    orgId: string;
    name: string;
    roles?: string[];
    capabilities?: string[];
    metadata?: Record<string, unknown>;
  }) {
    const now = new Date().toISOString();
    await this.db.insert(schema.principals).values({
      id: data.id,
      orgId: data.orgId,
      name: data.name,
      roles: JSON.stringify(data.roles ?? ['general-reviewer']),
      capabilities: JSON.stringify(data.capabilities ?? []),
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // Seed attention budget for the principal
    await this.db.insert(schema.attentionBudgets).values({
      principalId: data.id,
      earned: 15,
      spent: 0,
      earnRate: 5,
      lastEarnAt: now,
    });

    return this.getById(data.id);
  }

  async getById(id: string) {
    const rows = await this.db.select().from(schema.principals).where(eq(schema.principals.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.formatPrincipal(rows[0]);
  }

  async list(filters: { org?: string; role?: string; status?: string; page?: number; perPage?: number }) {
    const page = filters.page ?? 1;
    const perPage = filters.perPage ?? 20;
    const offset = (page - 1) * perPage;

    let query = this.db.select().from(schema.principals);

    const conditions = [];
    if (filters.org) {
      conditions.push(eq(schema.principals.orgId, filters.org));
    }
    if (filters.status) {
      conditions.push(eq(schema.principals.status, filters.status));
    } else {
      conditions.push(eq(schema.principals.status, 'active'));
    }

    if (conditions.length > 0) {
      query = this.db.select().from(schema.principals).where(and(...conditions));
    }

    const rows = await query.limit(perPage).offset(offset);
    return rows.map(r => this.formatPrincipal(r));
  }

  async update(id: string, data: { name?: string; roles?: string[]; capabilities?: string[]; metadata?: Record<string, unknown> }) {
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (data.name) updates.name = data.name;
    if (data.roles) updates.roles = JSON.stringify(data.roles);
    if (data.capabilities) updates.capabilities = JSON.stringify(data.capabilities);
    if (data.metadata) updates.metadata = JSON.stringify(data.metadata);

    await this.db.update(schema.principals).set(updates).where(eq(schema.principals.id, id));
    return this.getById(id);
  }

  async deactivate(id: string) {
    await this.db.update(schema.principals)
      .set({ status: 'decommissioned', updatedAt: new Date().toISOString() })
      .where(eq(schema.principals.id, id));
  }

  async getAgents(principalId: string) {
    const rows = await this.db.select().from(schema.agents).where(eq(schema.agents.principalId, principalId));
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      model: r.model,
      status: r.status,
      created_at: r.createdAt,
    }));
  }

  private formatPrincipal(row: typeof schema.principals.$inferSelect) {
    return {
      id: row.id,
      org_id: row.orgId,
      name: row.name,
      roles: JSON.parse(row.roles ?? '[]'),
      capabilities: JSON.parse(row.capabilities ?? '[]'),
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      status: row.status,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}
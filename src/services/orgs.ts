/**
 * Conclave — Organization service
 * CRUD operations for organizations
 */

import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';

export class OrgService {
  constructor(private db: ConclaveDb) {}

  async create(data: { id: string; ownerId: string; name: string; slug: string; description?: string; policies?: Record<string, unknown> }) {
    const now = new Date().toISOString();
    await this.db.insert(schema.organizations).values({
      id: data.id,
      name: data.name,
      slug: data.slug,
      description: data.description ?? null,
      policies: data.policies ? JSON.stringify(data.policies) : null,
      createdAt: now,
      ownerId: data.ownerId,
      updatedAt: now,
    });
    return this.getById(data.id);
  }

  async getById(id: string) {
    const rows = await this.db.select().from(schema.organizations).where(eq(schema.organizations.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.formatOrg(rows[0]);
  }

  async getBySlug(slug: string) {
    const rows = await this.db.select().from(schema.organizations).where(eq(schema.organizations.slug, slug)).limit(1);
    if (rows.length === 0) return null;
    return this.formatOrg(rows[0]);
  }

  async update(id: string, data: { name?: string; description?: string; policies?: Record<string, unknown> }) {
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (data.name) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.policies) updates.policies = JSON.stringify(data.policies);

    await this.db.update(schema.organizations).set(updates).where(eq(schema.organizations.id, id));
    return this.getById(id);
  }

  async getAgents(orgId: string) {
    const rows = await this.db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId));
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      model: r.model,
      status: r.status,
    }));
  }

  async addAgent(orgId: string, agentId: string) {
    await this.db.update(schema.agents).set({ orgId, updatedAt: new Date().toISOString() }).where(eq(schema.agents.id, agentId));
  }

  async list() {
    const rows = await this.db.select().from(schema.organizations);
    return rows.map(r => this.formatOrg(r));
  }

  async removeAgent(orgId: string, agentId: string) {
    // Move agent to a default org (or null) - for now just update
    // In production, this would be more nuanced
  }

  private formatOrg(row: typeof schema.organizations.$inferSelect) {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      policies: row.policies ? JSON.parse(row.policies) : {},
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}

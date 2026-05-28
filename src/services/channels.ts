/**
 * Conclave — Channel service
 * Channel management, subscription (by principals), and feed
 */

import { eq, and, not, inArray } from 'drizzle-orm';
import * as crypto from 'crypto';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';

export class ChannelService {
  constructor(private db: ConclaveDb) {}

  async list() {
    const rows = await this.db.select().from(schema.channels);
    return rows.map(r => this.formatChannel(r));
  }

  async getByName(name: string) {
    const rows = await this.db.select().from(schema.channels).where(eq(schema.channels.name, name)).limit(1);
    if (rows.length === 0) return null;
    return this.formatChannel(rows[0]);
  }

  async create(data: { name: string; description?: string; defaultDimensions?: string[]; createdByOrg?: string }) {
    const id = `ch_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await this.db.insert(schema.channels).values({
      id,
      name: data.name,
      description: data.description ?? null,
      defaultDimensions: data.defaultDimensions ? JSON.stringify(data.defaultDimensions) : null,
      createdByOrg: data.createdByOrg ?? null,
      createdAt: new Date().toISOString(),
    });
    return this.getByName(data.name);
  }

  async subscribe(principalId: string, channelId: string) {
    await this.db.insert(schema.channelSubscriptions).values({
      principalId,
      channelId,
      subscribedAt: new Date().toISOString(),
    }).onConflictDoNothing();
  }

  async isSubscribed(principalId: string, channelId: string): Promise<boolean> {
    const rows = await this.db.select().from(schema.channelSubscriptions)
      .where(and(
        eq(schema.channelSubscriptions.principalId, principalId),
        eq(schema.channelSubscriptions.channelId, channelId),
      ))
      .limit(1);
    return rows.length > 0;
  }

  async unsubscribe(principalId: string, channelId: string) {
    await this.db.delete(schema.channelSubscriptions)
      .where(and(
        eq(schema.channelSubscriptions.principalId, principalId),
        eq(schema.channelSubscriptions.channelId, channelId),
      ));
  }

  async getSubscribers(channelId: string) {
    const rows = await this.db.select({
      principalId: schema.channelSubscriptions.principalId,
      subscribedAt: schema.channelSubscriptions.subscribedAt,
    }).from(schema.channelSubscriptions)
      .where(eq(schema.channelSubscriptions.channelId, channelId));
    return rows;
  }

  async getFeed(channelName: string, limit: number = 20) {
    const tasks = await this.db.select().from(schema.tasks)
      .where(and(
        eq(schema.tasks.channel, channelName),
        not(inArray(schema.tasks.status, ['completed', 'cancelled']))
      ))
      .limit(limit);

    const opinions = await this.db.select().from(schema.opinions)
      .where(eq(schema.opinions.channel, channelName))
      .limit(limit);

    return {
      tasks: tasks.map(t => ({
        type: 'task_completed' as const,
        task_id: t.id,
        principal_id: t.principalId,
        description: t.description,
        channel: t.channel,
        status: t.status,
        created_at: t.createdAt,
      })),
      opinions: opinions.map(o => ({
        type: 'ask_opinion' as const,
        opinion_id: o.id,
        principal_id: o.principalId,
        question: o.question,
        channel: o.channel,
        created_at: o.createdAt,
      })),
    };
  }

  private formatChannel(row: typeof schema.channels.$inferSelect) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      default_dimensions: row.defaultDimensions ? JSON.parse(row.defaultDimensions) : [],
      created_at: row.createdAt,
    };
  }
}
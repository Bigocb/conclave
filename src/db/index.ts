/**
 * Initialize the database connection.
 * Returns the drizzle db instance and a cleanup function.
 * Attempts to push schema on first connection (creates tables if missing).
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type ConclaveDb = ReturnType<typeof drizzle<typeof schema>>;
export async function initDb(config: { url: string }): Promise<{ db: ConclaveDb; close: () => Promise<void> }> {
  const url = config.url;
  console.log(`[initDb] Connecting to PostgreSQL: ${url.replace(/:[^:@]+@/, ':***@')}`);

  const client = postgres(url, {
    ssl: url.includes('localhost') ? false : 'require',
    max: 10,
  });

  const db = drizzle(client, { schema });

  // Verify connection and push schema
  await client`SELECT 1`;
  console.log('[initDb] PostgreSQL connected');

  try {
    console.log('[initDb] Ensuring tables exist...');
    // Create tables if they don't exist (safe for re-runs — IF NOT EXISTS skips existing)
    await client`CREATE TABLE IF NOT EXISTS clv_organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      policies TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS clv_principals (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES clv_organizations(id),
      name TEXT NOT NULL,
      roles TEXT,
      capabilities TEXT,
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS clv_agents (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES clv_principals(id),
      org_id TEXT NOT NULL REFERENCES clv_organizations(id),
      name TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      llm_url TEXT,
      instructions TEXT,
      skills TEXT,
      type TEXT,
      command TEXT,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS clv_attention_budgets (
      principal_id TEXT PRIMARY KEY REFERENCES clv_principals(id),
      earned INTEGER NOT NULL DEFAULT 15,
      spent INTEGER NOT NULL DEFAULT 0,
      earn_rate INTEGER NOT NULL DEFAULT 5,
      last_earn_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS clv_budget_history (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES clv_principals(id),
      action TEXT NOT NULL,
      amount INTEGER NOT NULL,
      related_id TEXT,
      created_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS clv_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      default_dimensions TEXT,
      created_by_org TEXT REFERENCES clv_organizations(id),
      created_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS clv_channel_subscriptions (
      principal_id TEXT NOT NULL REFERENCES clv_principals(id),
      channel_id TEXT NOT NULL REFERENCES clv_channels(id),
      subscribed_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, principal_id)
    )`;
    await client`CREATE TABLE IF NOT EXISTS clv_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES clv_agents(id),
      principal_id TEXT NOT NULL REFERENCES clv_principals(id),
      description TEXT NOT NULL,
      dimensions TEXT NOT NULL,
      output TEXT NOT NULL,
      output_format TEXT DEFAULT 'markdown',
      channel TEXT NOT NULL,
      requested_reviews INTEGER NOT NULL DEFAULT 3,
      deadline TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      metadata TEXT,
      budget_spent INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS clv_reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES clv_tasks(id),
      reviewer_id TEXT NOT NULL REFERENCES clv_agents(id),
      principal_id TEXT NOT NULL REFERENCES clv_principals(id),
      scores TEXT NOT NULL,
      weighted_overall DOUBLE PRECISION NOT NULL,
      reviewer_confidence DOUBLE PRECISION NOT NULL,
      comment TEXT NOT NULL,
      suggestions TEXT,
      approved INTEGER NOT NULL DEFAULT 0,
      helpful INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT
    )`;
    // Ensure helpful column exists on older reviews tables
    await client`ALTER TABLE clv_reviews ADD COLUMN IF NOT EXISTS helpful INTEGER`;
    await client`CREATE TABLE IF NOT EXISTS clv_opinions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES clv_agents(id),
      principal_id TEXT NOT NULL REFERENCES clv_principals(id),
      question TEXT NOT NULL,
      context TEXT,
      channel TEXT NOT NULL,
      requested_opinions INTEGER NOT NULL DEFAULT 3,
      deadline TEXT,
      metadata TEXT,
      budget_spent INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS clv_opinion_responses (
      id TEXT PRIMARY KEY,
      opinion_id TEXT NOT NULL REFERENCES clv_opinions(id),
      principal_id TEXT NOT NULL REFERENCES clv_principals(id),
      response TEXT NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL
    )`;
    console.log('[initDb] Schema push complete');
  } catch (err: any) {
    if (err.code === '42P07' || err.message?.includes('already exists')) {
      console.log('[initDb] Tables already exist, skipping schema push');
    } else {
      console.error('[initDb] Schema push failed (continuing anyway):', err.message);
    }
  }

  // Auto-seed dev environment if empty
  try {
    const orgCount = await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1);
    if (orgCount.length === 0) {
      console.log('[initDb] Seeding dev environment...');
      const now = new Date().toISOString();
      const devOrgId = 'org_dev';
      const devPrnId = 'prn_dev';
      const devAgtId = 'agt_dev';
      const devToken = 'tk_dev_' + Date.now();

      await db.insert(schema.organizations).values({
        id: devOrgId, name: 'Dev Org', slug: 'dev', description: 'Default dev organization',
        policies: JSON.stringify({ min_reviews_required: 2 }), createdAt: now, updatedAt: now,
      }).onConflictDoNothing();
      await db.insert(schema.principals).values({
        id: devPrnId, orgId: devOrgId, name: 'Developer',
        roles: JSON.stringify(['admin', 'general-reviewer']), status: 'active',
        createdAt: now, updatedAt: now,
      }).onConflictDoNothing();
      await db.insert(schema.agents).values({
        id: devAgtId, principalId: devPrnId, orgId: devOrgId, name: 'Dev Agent',
        type: 'llm', model: 'glm-5.1', provider: 'ollama_cloud',
        llmUrl: 'https://www.ollama.com/v1', token: devToken, status: 'active',
        createdAt: now, updatedAt: now,
      }).onConflictDoNothing();
      await db.insert(schema.attentionBudgets).values({
        principalId: devPrnId, earned: 100, spent: 0, earnRate: 5, lastEarnAt: now,
      }).onConflictDoNothing();
      // Ensure general-qa channel exists
      await db.insert(schema.channels).values({
        id: 'ch_general_qa', name: 'general-qa', description: 'General Q&A review channel',
        createdAt: now,
      }).onConflictDoNothing();
      // Subscribe dev principal to general-qa
      await db.insert(schema.channelSubscriptions).values({
        principalId: devPrnId, channelId: 'ch_general_qa', subscribedAt: now,
      }).onConflictDoNothing();
      console.log('[initDb] Dev environment seeded (org_dev, prn_dev, agt_dev, general-qa)');
    } else {
      console.log('[initDb] Organizations already exist, skipping seed');
    }
  } catch (seedErr: any) {
    console.error('[initDb] Seed failed (non-fatal):', seedErr.message);
  }

  return {
    db,
    close: async () => {
      await client.end();
      console.log('[initDb] PostgreSQL connection closed');
    },
  };
}
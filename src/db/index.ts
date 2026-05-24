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
    console.log('[initDb] Pushing schema to ensure tables exist...');
    // Create tables if they don't exist using raw SQL
    await client`CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      policies TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS principals (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      roles TEXT,
      capabilities TEXT,
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES principals(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
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
    await client`CREATE TABLE IF NOT EXISTS attention_budgets (
      principal_id TEXT PRIMARY KEY REFERENCES principals(id),
      earned INTEGER NOT NULL DEFAULT 15,
      spent INTEGER NOT NULL DEFAULT 0,
      earn_rate INTEGER NOT NULL DEFAULT 5,
      last_earn_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS budget_history (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES principals(id),
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      rules TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS channel_subscribers (
      channel_id TEXT NOT NULL REFERENCES channels(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      subscribed_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, agent_id)
    )`;
    await client`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES principals(id),
      channel_id TEXT NOT NULL REFERENCES channels(id),
      task_description TEXT NOT NULL,
      output TEXT NOT NULL,
      dimensions TEXT,
      requested_reviews INTEGER DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'open',
      consensus_result TEXT,
      final_score DOUBLE PRECISION,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      reviewer_agent_id TEXT NOT NULL REFERENCES agents(id),
      reviewer_principal_id TEXT NOT NULL REFERENCES principals(id),
      scores TEXT NOT NULL,
      weighted_overall INTEGER NOT NULL,
      reviewer_confidence DOUBLE PRECISION DEFAULT 0.8,
      comment TEXT,
      approved BOOLEAN DEFAULT true,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS opinions (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id),
      principal_id TEXT NOT NULL REFERENCES principals(id),
      outcome TEXT NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL
    )`;
    await client`CREATE TABLE IF NOT EXISTS opinion_responses (
      id TEXT PRIMARY KEY,
      opinion_id TEXT NOT NULL REFERENCES opinions(id),
      principal_id TEXT NOT NULL REFERENCES principals(id),
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

  return {
    db,
    close: async () => {
      await client.end();
      console.log('[initDb] PostgreSQL connection closed');
    },
  };
}
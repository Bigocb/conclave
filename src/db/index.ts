/**
 * Conclave — Database connection module
 * Supports both SQLite (local) and PostgreSQL (production/Render).
 * Configured via DATABASE_TYPE env var or config.database.type.
 */

import BetterSqlite3 from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as schema from './schema.js';
import * as schemaPg from './schema.pg.js';

export type SqliteDb = ReturnType<typeof drizzleSqlite<typeof schema>>;
export type PgDb = ReturnType<typeof drizzlePg<typeof schemaPg>>;
export type ConclaveDb = SqliteDb | PgDb;

// ─── SQLite (local dev) ────────────────────────────────────

export function createSqliteDb(dbPath: string): SqliteDb {
  const sqlite = new BetterSqlite3(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzleSqlite(sqlite, { schema });
}

// ─── PostgreSQL (production) ───────────────────────────────

export function createPgDb(connectionString: string): PgDb {
  const client = postgres(connectionString, {
    ssl: 'require',
    max: 10,
  });
  return drizzlePg(client, { schema: schemaPg });
}

// ─── Unified init ──────────────────────────────────────────

/**
 * Initialize the database.
 * - SQLite: creates tables if they don't exist, runs migrations, seeds defaults.
 * - PostgreSQL: assumes tables are created via drizzle-kit migrate.
 */
export function initDb(config: { type: 'sqlite' | 'postgres'; url: string }): ConclaveDb {
  if (config.type === 'postgres') {
    console.log(`[initDb] Using PostgreSQL: ${config.url.replace(/:[^:@]+@/, ':***@')}`);
    const db = createPgDb(config.url);
    console.log('[initDb] PostgreSQL connected — assuming migrations are up to date');
    return db;
  }

  // SQLite path (local dev)
  const dbPath = config.url;
  const dir = path.dirname(dbPath);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const schemaSqlPath = path.join(thisDir, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaSqlPath, 'utf-8');

  const sqlite = new BetterSqlite3(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Create tables if they don't exist
  sqlite.exec(schemaSql);

  // Migrations for existing DBs
  const migrations = [
    'ALTER TABLE agents ADD COLUMN provider TEXT',
    'ALTER TABLE agents ADD COLUMN llm_url TEXT',
    'ALTER TABLE agents ADD COLUMN instructions TEXT',
    'ALTER TABLE agents ADD COLUMN skills TEXT',
    'ALTER TABLE agents ADD COLUMN type TEXT',
    'ALTER TABLE agents ADD COLUMN command TEXT',
  ];
  for (const sql of migrations) {
    try { sqlite.exec(sql); } catch (_) { /* column already exists */ }
  }

  // Seed defaults
  seedChannels(sqlite);
  seedDevDefaults(sqlite);

  sqlite.close();
  return createSqliteDb(dbPath);
}

// ─── Seeding (SQLite only — PG is seeded via migrations) ────

const DEFAULT_CHANNELS = [
  { name: 'code-review', description: 'Code artifacts, PRs, and implementation reviews', default_dimensions: '["correctness","completeness","efficiency","readability","security"]' },
  { name: 'architecture', description: 'System design, architecture proposals', default_dimensions: '["correctness","completeness","scalability","maintainability"]' },
  { name: 'general-qa', description: 'Open questions and advice', default_dimensions: '["relevance","depth","helpfulness"]' },
  { name: 'fact-check', description: 'Claim verification, source finding', default_dimensions: '["accuracy","completeness","sourcing"]' },
  { name: 'security-review', description: 'Security-focused reviews', default_dimensions: '["severity","exploitability","remediation-clarity","coverage"]' },
  { name: 'creative', description: 'Writing, design, creative work', default_dimensions: '["originality","coherence","quality","audience-fit"]' },
];

function seedChannels(sqlite: BetterSqlite3.Database) {
  const existing = sqlite.prepare('SELECT count(*) as count FROM channels').get() as any;
  if (existing.count === 0) {
    const insert = sqlite.prepare(
      'INSERT OR IGNORE INTO channels (id, name, description, default_dimensions, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const ch of DEFAULT_CHANNELS) {
      insert.run(
        `ch_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        ch.name,
        ch.description,
        ch.default_dimensions,
        new Date().toISOString()
      );
    }
  }
}

function seedDevDefaults(sqlite: BetterSqlite3.Database) {
  const now = new Date().toISOString();

  const orgCount = (sqlite.prepare("SELECT count(*) as count FROM organizations WHERE id = 'org_dev'").get() as any).count;
  if (orgCount === 0) {
    sqlite.prepare(
      'INSERT OR IGNORE INTO organizations (id, name, slug, description, policies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('org_dev', 'Dev Organization', 'dev', 'Default organization for local development', '{}', now, now);
  }

  const principalCount = (sqlite.prepare("SELECT count(*) as count FROM principals WHERE id = 'prn_dev'").get() as any).count;
  if (principalCount === 0) {
    sqlite.prepare(
      'INSERT OR IGNORE INTO principals (id, org_id, name, roles, capabilities, metadata, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('prn_dev', 'org_dev', 'Dev Principal', '["general-reviewer"]', '[]', '{}', 'active', now, now);
  }

  const budgetCount = (sqlite.prepare("SELECT count(*) as count FROM attention_budgets WHERE principal_id = 'prn_dev'").get() as any).count;
  if (budgetCount === 0) {
    sqlite.prepare(
      'INSERT OR IGNORE INTO attention_budgets (principal_id, earned, spent, earn_rate, last_earn_at) VALUES (?, ?, ?, ?, ?)'
    ).run('prn_dev', 15, 0, 5, now);
  }

  const agentCount = (sqlite.prepare("SELECT count(*) as count FROM agents WHERE id = 'agt_dev'").get() as any).count;
  if (agentCount === 0) {
    sqlite.prepare(
      'INSERT OR IGNORE INTO agents (id, principal_id, org_id, name, model, token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('agt_dev', 'prn_dev', 'org_dev', 'Dev Agent', null, 'clv_dev_local_token', 'active', now, now);
  }
}
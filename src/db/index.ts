/**
 * Conclave — Database connection module
 * Creates and initializes the Drizzle ORM database connection.
 */

import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as schema from './schema.js';

export type ConclaveDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Create a Drizzle database instance connected to a SQLite file.
 */
export function createDb(dbPath: string): ConclaveDb {
  const sqlite = new BetterSqlite3(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

/**
 * Initialize the database by creating tables if they don't exist.
 * Reads and executes the schema.sql file.
 */
export function initDb(dbPath: string): ConclaveDb {
  const dir = path.dirname(dbPath);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Read and execute schema.sql to create tables
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  console.log('[initDb] Resolved dir:', thisDir);
  const schemaSqlPath = path.join(thisDir, 'schema.sql');
  console.log('[initDb] Looking for schema at:', schemaSqlPath);
  const schemaSql = fs.readFileSync(schemaSqlPath, 'utf-8');

  const sqlite = new BetterSqlite3(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Execute the entire schema SQL at once — SQLite handles multi-statement
  sqlite.exec(schemaSql);

  // Migrations for existing DBs (idempotent — ALTER TABLE ADD COLUMN is safe if column exists)
  const migrations = [
    'ALTER TABLE agents ADD COLUMN provider TEXT',
    'ALTER TABLE agents ADD COLUMN llm_url TEXT',
  ];
  for (const sql of migrations) {
    try { sqlite.exec(sql); } catch (_) { /* column already exists */ }
  }

  // Seed default channels & dev org/principal/agent
  seedChannels(sqlite);
  seedDevDefaults(sqlite);

  sqlite.close();
  return createDb(dbPath);
}

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

  // Seed dev org if not exists
  const orgCount = (sqlite.prepare("SELECT count(*) as count FROM organizations WHERE id = 'org_dev'").get() as any).count;
  if (orgCount === 0) {
    sqlite.prepare(
      'INSERT OR IGNORE INTO organizations (id, name, slug, description, policies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('org_dev', 'Dev Organization', 'dev', 'Default organization for local development', '{}', now, now);
  }

  // Seed dev principal if not exists
  const principalCount = (sqlite.prepare("SELECT count(*) as count FROM principals WHERE id = 'prn_dev'").get() as any).count;
  if (principalCount === 0) {
    sqlite.prepare(
      'INSERT OR IGNORE INTO principals (id, org_id, name, roles, capabilities, metadata, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('prn_dev', 'org_dev', 'Dev Principal', '["general-reviewer"]', '[]', '{}', 'active', now, now);
  }

  // Seed dev principal budget if not exists
  const budgetCount = (sqlite.prepare("SELECT count(*) as count FROM attention_budgets WHERE principal_id = 'prn_dev'").get() as any).count;
  if (budgetCount === 0) {
    sqlite.prepare(
      'INSERT OR IGNORE INTO attention_budgets (principal_id, earned, spent, earn_rate, last_earn_at) VALUES (?, ?, ?, ?, ?)'
    ).run('prn_dev', 15, 0, 5, now);
  }

  // Seed dev agent under the principal if not exists
  const agentCount = (sqlite.prepare("SELECT count(*) as count FROM agents WHERE id = 'agt_dev'").get() as any).count;
  if (agentCount === 0) {
    sqlite.prepare(
      'INSERT OR IGNORE INTO agents (id, principal_id, org_id, name, model, token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('agt_dev', 'prn_dev', 'org_dev', 'Dev Agent', null, 'clv_dev_local_token', 'active', now, now);
  }
}
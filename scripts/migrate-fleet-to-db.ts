import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { nanoid } from 'nanoid';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { resolve } from 'path';
import { eq } from 'drizzle-orm';

async function runMigration() {
  // Connection string comes from the environment — never commit credentials.
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const db = drizzle(pool, { schema });

  try {
    console.log('Ensuring tables exist...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "clv_fleet_config" (
        "org_id" text PRIMARY KEY REFERENCES "clv_organizations"("id"),
        "server" text NOT NULL,
        "scope" text DEFAULT 'public',
        "providers" text,
        "updated_at" text NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS "clv_fleet_reviewers" (
        "id" text PRIMARY KEY,
        "org_id" text NOT NULL REFERENCES "clv_fleet_config"("org_id"),
        "name" text NOT NULL,
        "channels" text NOT NULL,
        "type" text DEFAULT 'llm',
        "model" text,
        "provider" text,
        "llm_url" text,
        "llm_key" text,
        "command" text,
        "replicas" integer DEFAULT 1,
        "mode" text DEFAULT 'auto',
        "confidence_threshold" integer DEFAULT 8,
        "prompt" text,
        "instructions" text,
        "skills" text,
        "steps" text,
        "interval" integer,
        "max_concurrent" integer DEFAULT 1,
        "created_at" text NOT NULL DEFAULT now(),
        "updated_at" text NOT NULL DEFAULT now()
      );
    `);

    const configPath = resolve('./fleet.yaml');
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);

    if (!parsed.org_id) {
      throw new Error('fleet.yaml: missing required field "org_id"');
    }

    console.log(`Migrating fleet.yaml for org: ${parsed.org_id}`);

    await db.insert(schema.fleetConfig).values({
      orgId: parsed.org_id,
      server: parsed.server,
      scope: parsed.scope || 'public',
      providers: parsed.providers ? JSON.stringify(parsed.providers) : null,
    }).onConflictDoUpdate({
      target: schema.fleetConfig.orgId,
      set: {
        server: parsed.server,
        scope: parsed.scope || 'public',
        providers: parsed.providers ? JSON.stringify(parsed.providers) : null,
        updatedAt: new Date().toISOString(),
      }
    });

    // CORRECTED: Using eq() for the where clause
    await db.delete(schema.fleetReviewers).where(eq(schema.fleetReviewers.orgId, parsed.org_id));

    for (const r of parsed.reviewers) {
      const id = `rev_blueprint_${nanoid(12)}`;
      await db.insert(schema.fleetReviewers).values({
        id,
        orgId: parsed.org_id,
        name: r.name,
        channels: JSON.stringify(r.channels),
        type: r.type || 'llm',
        model: r.model,
        provider: r.provider,
        llmUrl: r.llm_url,
        llmKey: r.llm_key,
        command: r.command,
        replicas: r.replicas || 1,
        mode: r.mode || 'auto',
        confidenceThreshold: r.confidence_threshold || 8,
        prompt: r.prompt,
        instructions: r.instructions,
        skills: r.skills ? JSON.stringify(r.skills) : null,
        steps: r.steps ? JSON.stringify(r.steps) : null,
        interval: r.interval,
        maxConcurrent: r.max_concurrent || 1,
      });
    }

    console.log('Migration successful.');
  } catch (e) {
    console.error('Migration failed:', e);
  } finally {
    await pool.end();
  }
}

runMigration();

import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { resolve } from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { nanoid } from 'nanoid';

async function runMigration() {
  const DATABASE_URL = process.env.DATABASE_URL || 'postgres://conclave:conclave@localhost:5432/conclave';
  console.log(`Connecting to DB: ${DATABASE_URL}`);
  
  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool, { schema });

  try {
    const configPath = resolve('./fleet.yaml');
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);

    if (!parsed.org_id) {
      throw new Error('fleet.yaml: missing required field "org_id"');
    }

    console.log(`Migrating fleet.yaml for org: ${parsed.org_id}`);

    // 1. Save Global Config
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

    // 2. Clear old blueprints for this org to avoid duplicates during migration
    await db.delete(schema.fleetReviewers).where(schema.fleetReviewers.orgId, 'eq', parsed.org_id);

    // 3. Save Reviewers
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

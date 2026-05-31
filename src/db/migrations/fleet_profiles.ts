import * as fs from 'fs';

/**
 * Migrate fleet config from YAML to DB-driven profiles.
 *
 * IMPORTANT: The postgres.js (postgres) client treats template literal
 * interpolations (${var}) as parameterized query values ($1, $2, …).
 * DDL and raw SQL scripts cannot use parameterized values — PostgreSQL
 * rejects them with "syntax error at or near $1".
 *
 * Inside dbClient.begin(), the `sql` tagged template IS safe for inline DDL
 * because the SQL is written directly in the template literal (no variables).
 * But for dynamic SQL read from a file, we must use dbClient.unsafe().
 *
 * NOTE: All ID columns use TEXT (not UUID) to match the existing Conclave
 * schema. Existing tables like clv_agents use TEXT IDs (e.g. 'agt_xxx').
 */
export async function migrateFleetToProfiles(dbClient: any) {
    try {
        console.log('[Migration] Starting Fleet Profile migration...');

        await dbClient.begin(async (sql: any) => {
            // 1. Tables — inline DDL is safe in tagged templates (no variables)
            // Using TEXT IDs to match the rest of the Conclave schema
            await sql`
                CREATE TABLE IF NOT EXISTS clv_agent_profiles (
                    id TEXT PRIMARY KEY,
                    org_id TEXT NOT NULL REFERENCES clv_organizations(id),
                    name TEXT NOT NULL UNIQUE,
                    model TEXT,
                    provider TEXT,
                    temperature FLOAT DEFAULT 0.3,
                    instructions TEXT,
                    skills TEXT[],
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
                    updated_at TEXT
                );
            `;

            await sql`
                CREATE TABLE IF NOT EXISTS clv_fleet_config (
                    org_id TEXT PRIMARY KEY REFERENCES clv_organizations(id),
                    server TEXT NOT NULL,
                    scope TEXT NOT NULL DEFAULT 'public',
                    providers TEXT,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
                );
            `;

            await sql`
                CREATE TABLE IF NOT EXISTS clv_fleet_reviewers (
                    id TEXT PRIMARY KEY,
                    org_id TEXT NOT NULL REFERENCES clv_fleet_config(org_id),
                    name TEXT NOT NULL,
                    channels TEXT NOT NULL,
                    type TEXT NOT NULL DEFAULT 'llm',
                    model TEXT,
                    provider TEXT,
                    llm_url TEXT,
                    llm_key TEXT,
                    command TEXT,
                    replicas INTEGER DEFAULT 1,
                    mode TEXT NOT NULL DEFAULT 'auto',
                    confidence_threshold INTEGER DEFAULT 8,
                    prompt TEXT,
                    instructions TEXT,
                    skills TEXT,
                    steps TEXT,
                    interval INTEGER,
                    max_concurrent INTEGER DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
                );
            `;

            // Add fleet_reviewer_id to agents — TEXT to match agents.id convention
            await sql`
                ALTER TABLE clv_agents ADD COLUMN IF NOT EXISTS fleet_reviewer_id TEXT REFERENCES clv_fleet_reviewers(id);
            `;
        });

        console.log('[Migration] Tables verified/created. Checking for data import...');

        // 2. Data Migration from fleet.yaml
        const configCheck = await dbClient`SELECT COUNT(*) as count FROM clv_fleet_config`;
        const count = configCheck[0]?.count || 0;

        if (count === 0) {
            console.log('[Migration] Importing data from fleet.yaml...');

            try {
                const dataSql = fs.readFileSync('/tmp/fleet_data.sql', 'utf8');
                // Must use unsafe() — dynamic SQL cannot be parameterized
                await dbClient.unsafe(dataSql);
                console.log('[Migration] Initial data import completed.');
            } catch (fileErr: any) {
                console.warn('[Migration] Could not load /tmp/fleet_data.sql, skipping import:', fileErr.message);
            }
        } else {
            console.log('[Migration] Fleet config already populated, skipping import.');
        }

        console.log('[Migration] Fleet Profile migration successful.');
    } catch (e) {
        console.error('[Migration] Fatal error during fleet migration:', e);
        throw e;
    }
}

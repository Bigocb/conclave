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
 */
export async function migrateFleetToProfiles(dbClient: any) {
    try {
        console.log('[Migration] Starting Fleet Profile migration...');
        
        await dbClient.begin(async (sql) => {
            // 1. Tables — inline DDL is safe in tagged templates (no variables)
            await sql`
                CREATE TABLE IF NOT EXISTS clv_agent_profiles (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    name TEXT NOT NULL UNIQUE,
                    model TEXT,
                    provider TEXT,
                    temperature FLOAT DEFAULT 0.3,
                    instructions TEXT,
                    skills TEXT[],
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `;

            await sql`
                CREATE TABLE IF NOT EXISTS clv_fleet_config (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `;

            await sql`
                CREATE TABLE IF NOT EXISTS clv_fleet_reviewers (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    profile_id UUID REFERENCES clv_agent_profiles(id),
                    channel TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    replicas INTEGER DEFAULT 1,
                    interval INTEGER DEFAULT 30,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(profile_id, channel)
                );
            `;

            await sql`
                ALTER TABLE clv_agents ADD COLUMN IF NOT EXISTS clv_fleet_reviewer_id UUID REFERENCES clv_fleet_reviewers(id);
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


import pg from 'pg';
import fs from 'fs';

export async function migrateFleetToProfiles() {
    const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        console.log('[Migration] Starting Fleet Profile migration...');
        
        await client.query('BEGIN');

        // 1. Tables
        await client.query(`
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
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS clv_fleet_config (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
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
        `);

        await client.query(`
            ALTER TABLE clv_agents ADD COLUMN IF NOT EXISTS clv_fleet_reviewer_id UUID REFERENCES clv_fleet_reviewers(id);
        `);

        console.log('[Migration] Tables verified/created. Checking for data import...');

        // 2. Data Migration from fleet.yaml
        // We do this only if the config table is empty to avoid duplicates on every restart
        const configCheck = await client.query('SELECT COUNT(*) FROM clv_fleet_config');
        if (parseInt(configCheck.rows[0].count) === 0) {
            console.log('[Migration] Importing data from fleet.yaml...');
            
            // We read the file from the filesystem
            const yamlContent = fs.readFileSync('/home/bigocb/dev/conclave/fleet.yaml', 'utf8');
            // Using a simple regex/split parser here since we can't guarantee yaml lib in the runtime
            // But for the migration, we'll use a more robust approach if possible.
            // Actually, let's just use a helper to parse the flat YAML as a JSON-like object
            // for the purpose of this one-time migration.
            
            // Instead of risking a parser error, I'll use the raw SQL we generated earlier
            // and execute it now via the client.
            const dataSql = fs.readFileSync('/tmp/fleet_data.sql', 'utf8');
            await client.query(dataSql);
            console.log('[Migration] Initial data import completed.');
        } else {
            console.log('[Migration] Fleet config already populated, skipping import.');
        }

        await client.query('COMMIT');
        console.log('[Migration] Fleet Profile migration successful.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[Migration] Fatal error during fleet migration:', e);
        throw e;
    } finally {
        await client.end();
    }
}

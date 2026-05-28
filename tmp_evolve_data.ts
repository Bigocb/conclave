
import pg from 'pg';
import fs from 'fs';

async function run() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('DATABASE_URL missing');
        process.exit(1);
    }

    const client = new pg.Client({
        connectionString: dbUrl,
        // Only use SSL if we are not in 'local' mode or if the URL contains sslmode
        ssl: dbUrl.includes('sslmode') ? { rejectUnauthorized: false } : false
    });

    try {
        await client.connect();
        const sql = fs.readFileSync('/tmp/evolve_fleet_data.sql', 'utf8');
        await client.query(sql);
        console.log('✅ Fleet data migrated to profiles successfully.');
    } catch (e) {
        console.error('❌ Migration failed:', e);
        process.exit(1);
    } finally {
        await client.end();
    }
}
run();

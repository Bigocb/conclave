
import pg from 'pg';
import fs from 'fs';

async function run() {
    const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
    });
    await client.connect();
    
    try {
        console.log('Running schema migration...');
        const schemaSql = fs.readFileSync('/tmp/fleet_migration.sql', 'utf8');
        await client.query(schemaSql);
        
        console.log('Running data import...');
        const dataSql = fs.readFileSync('/tmp/fleet_data.sql', 'utf8');
        await client.query(dataSql);
        
        console.log('✅ Fleet migration completed successfully.');
    } catch (e) {
        console.error('❌ Migration failed:', e);
        process.exit(1);
    } finally {
        await client.end();
    }
}
run();

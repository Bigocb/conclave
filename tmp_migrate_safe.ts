
import pg from 'pg';
import fs from 'fs';

async function run() {
    const connectionString = "None";
    const client = new pg.Client({
        connectionString: connectionString,
        ssl: { rejectUnauthorized: false } // Necessary for Render/AWS RDS
    });
    
    try {
        await client.connect();
        console.log('Connected to database.');

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

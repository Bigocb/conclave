import { Pool } from 'pg';

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL || 'postgres://conclave:conclave@localhost:5432/conclave';
  const pool = new Pool({ connectionString: DATABASE_URL });
  
  try {
    console.log('--- Checking clv_organizations ---');
    const orgs = await pool.query('SELECT id, name FROM clv_organizations');
    console.table(orgs.rows);

    console.log('\n--- Checking clv_agents for org_ids ---');
    const agents = await pool.query('SELECT DISTINCT org_id FROM clv_agents');
    console.table(agents.rows);

    console.log('\n--- Checking clv_principals for org_ids ---');
    const principals = await pool.query('SELECT DISTINCT org_id FROM clv_principals');
    console.table(principals.rows);
  } catch (e) {
    console.error('Query failed:', e);
  } finally {
    await pool.end();
  }
}

main();

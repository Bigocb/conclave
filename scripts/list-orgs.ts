import { Pool } from 'pg';

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL || 'postgres://conclave:conclave@localhost:5432/conclave';
  const pool = new Pool({ connectionString: DATABASE_URL });
  
  try {
    const res = await pool.query('SELECT id, name FROM clv_organizations');
    console.log('Organizations in DB:');
    console.table(res.rows);
  } catch (e) {
    console.error('Query failed:', e);
  } finally {
    await pool.end();
  }
}

main();

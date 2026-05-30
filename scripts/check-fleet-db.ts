import pg from 'pg';
const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://promptoria_db_user:***@dpg-d79au56dqaus739isukg-a.oregon-postgres.render.com/promptoria_db';

async function run() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const config = await client.query('SELECT * FROM clv_fleet_config');
  console.log('=== clv_fleet_config ===');
  console.log(JSON.stringify(config.rows, null, 2));

  const reviewers = await client.query('SELECT * FROM clv_fleet_reviewers');
  console.log('\n=== clv_fleet_reviewers ===');
  console.log(JSON.stringify(reviewers.rows, null, 2));

  const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%fleet%' OR table_name LIKE '%profile%'");
  console.log('\n=== fleet/profile-related tables ===');
  console.log(JSON.stringify(tables.rows.map(r => r.table_name), null, 2));

  const columns = await client.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'clv_fleet_config'");
  console.log('\n=== clv_fleet_config columns ===');
  columns.rows.forEach(c => console.log(`  ${c.column_name} (${c.data_type}) ${c.is_nullable === 'YES' ? 'nullable' : 'not null'}`));

  const revCols = await client.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'clv_fleet_reviewers'");
  console.log('\n=== clv_fleet_reviewers columns ===');
  revCols.rows.forEach(c => console.log(`  ${c.column_name} (${c.data_type}) ${c.is_nullable === 'YES' ? 'nullable' : 'not null'}`));

  await client.end();
}
run().catch(e => { console.error(e); process.exit(1); });

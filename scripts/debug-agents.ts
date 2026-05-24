import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require' });

async function main() {
  // Exact review IDs
  const reviews = await sql`SELECT r.id, r.task_id, r.reviewer_id, r.principal_id FROM clv_reviews r WHERE r.task_id LIKE 'tsk_65b0%'`;
  console.log('=== Reviews for tsk_65b0 ===');
  for (const r of reviews) {
    console.log(`  review=${r.id}  task_id="${r.task_id}"  reviewer_id="${r.reviewer_id}"  principal="${r.principal_id}"`);
  }

  // Check agent mapping for code-review principals
  const agents = await sql`
    SELECT a.id, a.principal_id, a.name, a.model 
    FROM clv_agents a 
    WHERE a.status = 'active' 
    AND a.principal_id IN ('prn_4b9c697c5fb94c9c846bb976', 'prn_c51fcb53a8014d72a86fdf31')
    ORDER BY a.principal_id, a.name
  `;
  console.log('\n=== Agents for code-review principals ===');
  for (const a of agents) {
    console.log(`  ${a.id}  principal=${a.principal_id}  model=${a.model}  name="${a.name}"`);
  }

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
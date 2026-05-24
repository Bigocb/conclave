import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require' });

async function main() {
  // Check the empty-comment review
  const review = await sql`SELECT id, task_id, reviewer_id, principal_id, weighted_overall, approved, comment, scores, suggestions FROM clv_reviews WHERE id = 'rev_11392e53-6c4c-40b4-9488-d1d2aef5b7c2'`;
  console.log('=== Empty-comment review ===');
  console.log(JSON.stringify(review, null, 2));

  // Check the stuck task
  const task = await sql`SELECT id, status, requested_reviews, channel, principal_id, description FROM clv_tasks WHERE id LIKE 'tsk_65b0%'`;
  console.log('\n=== Stuck in_review task ===');
  console.log(JSON.stringify(task, null, 2));

  // How many reviews per task
  const counts = await sql`SELECT t.id, t.status, t.requested_reviews, COUNT(r.id) as review_count FROM clv_tasks t LEFT JOIN clv_reviews r ON r.task_id = t.id GROUP BY t.id ORDER BY t.id`;
  console.log('\n=== Task review counts ===');
  for (const c of counts) {
    console.log(`  ${(c as any).id?.slice(0,8)}  status=${c.status}  requested=${c.requested_reviews}  actual=${c.review_count}`);
  }

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
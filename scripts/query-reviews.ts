import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { ssl: process.env.DATABASE_URL!.includes('localhost') ? false : 'require' });

async function main() {
  const reviews = await sql`SELECT id, task_id, reviewer_id, principal_id, weighted_overall, approved, status, LEFT(comment, 120) as comment_preview FROM clv_reviews ORDER BY created_at DESC LIMIT 15`;
  console.log('\n=== Reviews ===');
  for (const r of reviews) {
    console.log(`  ${r.id}  task=${(r as any).task_id?.slice(0,8)}  reviewer=${r.reviewer_id}  principal=${r.principal_id}  overall=${r.weighted_overall}  approved=${r.approved}  status=${r.status}`);
    console.log(`    comment: ${r.comment_preview || '(empty)'}`);
  }

  const count = await sql`SELECT task_id, COUNT(*) as review_count FROM clv_reviews GROUP BY task_id ORDER BY task_id`;
  console.log('\n=== Review counts per task ===');
  for (const c of count) {
    console.log(`  ${(c as any).task_id?.slice(0,8)}...  reviews=${c.review_count}`);
  }

  // Check the in_review task
  const inReview = await sql`SELECT id, status, requested_reviews, principal_id, channel FROM clv_tasks WHERE status = 'in_review'`;
  console.log('\n=== In-review tasks ===');
  for (const t of inReview) {
    console.log(`  ${t.id}  principal=${t.principal_id}  channel=${t.channel}  requested=${t.requested_reviews}`);
  }

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
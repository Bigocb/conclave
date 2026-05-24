import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require' });

async function main() {
  // What channels exist?
  const channels = await sql`SELECT id, name FROM clv_channels`;
  console.log('=== Channels ===');
  for (const c of channels) {
    console.log(`  ${c.id} → "${c.name}"`);
  }

  // What channel does the stuck task have?
  const task = await sql`SELECT id, channel FROM clv_tasks WHERE id LIKE 'tsk_65b0%'`;
  console.log('\n=== Task channel ===');
  for (const t of task) {
    console.log(`  ${t.id} → "${t.channel}"`);
  }

  // What does the subscription data look like?
  const subs = await sql`SELECT cs.principal_id, cs.channel_id, ch.name FROM clv_channel_subscriptions cs JOIN clv_channels ch ON ch.id = cs.channel_id WHERE ch.name = 'code-review'`;
  console.log('\n=== Code-review subscriptions ===');
  for (const s of subs) {
    console.log(`  principal=${s.principal_id}  channel_id=${s.channel_id}  name="${(s as any).name}"`);
  }

  // Who already reviewed tsk_65b0?
  const reviews = await sql`SELECT r.reviewer_id, r.principal_id FROM clv_reviews r WHERE r.task_id = 'tsk_65b06b9e215a457aa051385c'`;
  console.log('\n=== Existing reviews for tsk_65b0 ===');
  for (const r of reviews) {
    console.log(`  reviewer=${r.reviewer_id}  principal=${r.principal_id}`);
  }

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
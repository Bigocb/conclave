import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require' });

async function main() {
  // Channel subscriptions
  const subs = await sql`SELECT cs.principal_id, cs.channel_id, ch.name as channel_name FROM clv_channel_subscriptions cs JOIN clv_channels ch ON ch.id = cs.channel_id ORDER BY ch.name`;
  console.log('=== Channel subscriptions ===');
  for (const s of subs) {
    console.log(`  principal=${s.principal_id}  channel=${(s as any).channel_name} (${s.channel_id})`);
  }

  // Which principals have agents on general-qa?
  const agents = await sql`SELECT a.id, a.principal_id, a.name, a.model FROM clv_agents a WHERE a.status = 'active' ORDER BY a.principal_id`;
  console.log('\n=== Active agents ===');
  for (const a of agents) {
    console.log(`  ${a.id}  principal=${a.principal_id}  model=${a.model}  name=${a.name}`);
  }

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });

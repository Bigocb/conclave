import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require' });

async function main() {
  // Reset the stuck in_review task back to open with cleared retry count
  const result = await sql`
    UPDATE clv_tasks
    SET status = 'open', metadata = '{}'::jsonb
    WHERE id = 'tsk_65b06b9e215a457aa051385c'
    RETURNING id, status
  `;
  console.log('Reset task:', result);

  // Also reset our test task
  const result2 = await sql`
    UPDATE clv_tasks
    SET metadata = '{}'::jsonb
    WHERE id = 'tsk_1690909ec35d4432a2a3fe7e'
    RETURNING id, status
  `;
  console.log('Reset task:', result2);

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
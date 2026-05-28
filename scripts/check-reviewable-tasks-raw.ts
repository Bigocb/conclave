
import postgres from 'postgres';
import process from 'node:process';

async function checkTasks() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const sql = postgres(dbUrl, {
    ssl: dbUrl.includes('localhost') ? false : 'require',
  });

  try {
    const result = await sql`SELECT * FROM clv_tasks WHERE status = 'open' ORDER BY created_at DESC LIMIT 10`;
    if (result.length === 0) {
      console.log(JSON.stringify({ message: 'No reviewable tasks found.' }));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

checkTasks();

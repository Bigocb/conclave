
import postgres from "postgres";

const sql = postgres("postgresql://promptoria_db_user:VMsV40FYzcy1BmbWnqCWwiPrmGXuoh0k@dpg-d79au56dqaus739isukg-a.oregon-postgres.render.com/promptoria_db", { ssl: "require" });

async function run() {
  try {
    console.log("Checking columns for clv_users...");
    const result = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'clv_users'
    `;
    console.log("Columns found:", result);
  } catch (e) {
    console.error("❌ Error querying columns:", e);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

run();

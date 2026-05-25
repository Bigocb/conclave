
import postgres from "postgres";

const sql = postgres("postgresql://promptoria_db_user:VMsV40FYzcy1BmbWnqCWwiPrmGXuoh0k@dpg-d79au56dqaus739isukg-a.oregon-postgres.render.com/promptoria_db", { ssl: "require" });

async function run() {
  try {
    console.log("Columns for clv_users:");
    const cols = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'clv_users'`;
    console.log(cols);
  } catch (e) {
    console.error("❌ Error:", e);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

run();

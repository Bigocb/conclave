
import postgres from "postgres";

const sql = postgres("postgresql://promptoria_db_user:VMsV40FYzcy1BmbWnqCWwiPrmGXuoh0k@dpg-d79au56dqaus739isukg-a.oregon-postgres.render.com/promptoria_db", { ssl: "require" });

async function run() {
  try {
    console.log("Checking tables...");
    const result = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    console.log("Tables found:", result.map(r => r.table_name));
  } catch (e) {
    console.error("❌ Error querying tables:", e);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

run();

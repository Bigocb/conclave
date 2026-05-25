
import postgres from "postgres";

const sql = postgres("postgresql://promptoria_db_user:VMsV40FYzcy1BmbWnqCWwiPrmGXuoh0k@dpg-d79au56dqaus739isukg-a.oregon-postgres.render.com/promptoria_db", { ssl: "require" });

async function run() {
  try {
    console.log("Checking if clv_organizations exists...");
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_name = 'clv_organizations'`;
    console.log("Organizations Table:", tables);

    console.log("Checking if clv_users exists...");
    const users = await sql`SELECT table_name FROM information_schema.tables WHERE table_name = 'clv_users'`;
    console.log("Users Table:", users);
  } catch (e) {
    console.error("❌ Error:", e);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

run();

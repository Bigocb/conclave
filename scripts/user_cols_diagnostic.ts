
import postgres from "postgres";

// Connection string comes from the environment — never commit credentials.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });

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

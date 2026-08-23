
import postgres from "postgres";

// Connection string comes from the environment — never commit credentials.
const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

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

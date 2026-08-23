
import postgres from "postgres";

// Connection string comes from the environment — never commit credentials.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });

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

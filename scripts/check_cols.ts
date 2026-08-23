
import postgres from "postgres";

// Connection string comes from the environment — never commit credentials.
const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

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

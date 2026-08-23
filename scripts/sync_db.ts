
import postgres from "postgres";
import fs from "fs";

// Connection string comes from the environment — never commit credentials.
const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

async function run() {
  try {
    console.log("Applying schema...");
    const content = fs.readFileSync("/home/bigocb/dev/conclave/drizzle/0000_daffy_dark_beast.sql", "utf8");
    const statements = content.split('-- statement-breakpoint');
    for (const statement of statements) {
      if (statement.trim()) {
        await sql.unsafe(statement.trim());
      }
    }
    console.log("✅ Schema applied successfully");
  } catch (e) {
    console.error("❌ Error applying schema:", e);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

run();

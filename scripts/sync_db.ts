
import postgres from "postgres";
import fs from "fs";

const sql = postgres("postgresql://promptoria_db_user:VMsV40FYzcy1BmbWnqCWwiPrmGXuoh0k@dpg-d79au56dqaus739isukg-a.oregon-postgres.render.com/promptoria_db", { ssl: "require" });

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

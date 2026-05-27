import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL || 'postgres://conclave:conclave@localhost:5432/conclave';
  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool, { schema });

  const orgId = 'org_019e6027-580a-767a-8f13-cf40de5363a9';
  const result = await db.select().from(schema.organizations).where(schema.organizations.id, 'eq', orgId);
  console.log('Org match:', result);
  
  const all = await db.select().from(schema.organizations).limit(10);
  console.log('All orgs:', all);
  
  await pool.end();
}

main().catch(console.error);

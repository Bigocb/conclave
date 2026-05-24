/**
 * Conclave — Database connection module (PostgreSQL only)
 * Uses drizzle-orm/postgres-js for production and local dev.
 * Run `npx drizzle-kit push` to create/migrate tables.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
// @ts-expect-error - postgres uses CJS export =, esModuleInterop handles at runtime
import postgres from 'postgres';
import * as schema from './schema.js';

export type ConclaveDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Initialize the database connection.
 * Returns the drizzle db instance and a cleanup function.
 * Tables should be created via `drizzle-kit push` before starting the server.
 */
export async function initDb(config: { url: string }): Promise<{ db: ConclaveDb; close: () => Promise<void> }> {
  const url = config.url;
  console.log(`[initDb] Connecting to PostgreSQL: ${url.replace(/:[^:@]+@/, ':***@')}`);

  const client = postgres(url, {
    ssl: url.includes('localhost') ? false : 'require',
    max: 10,
  });

  const db = drizzle(client, { schema });

  // Verify connection
  await client`SELECT 1`;
  console.log('[initDb] PostgreSQL connected');

  return {
    db,
    close: async () => {
      await client.end();
      console.log('[initDb] PostgreSQL connection closed');
    },
  };
}
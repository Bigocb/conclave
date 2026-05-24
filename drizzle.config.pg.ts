import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.pg.ts',
  out: './drizzle/pg-migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
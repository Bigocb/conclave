/**
 * Conclave — Entry point
 * Starts the server when run directly.
 * Uses PostgreSQL only — set DATABASE_URL env var.
 */

import { startServer } from './server/index.js';
import { applyPerformanceIndexes } from './db/apply-indexes.js';

const config = {
  mode: (process.env.CONCLAVE_MODE || 'local') as 'local' | 'self-hosted' | 'cloud',
  port: parseInt(process.env.CONCLAVE_PORT || '3000'),
  host: process.env.CONCLAVE_HOST || '0.0.0.0',
  database: {
    url: process.env.DATABASE_URL || 'postgres://localhost:5432/conclave',
  },
  jwtSecret: process.env.CONCLAVE_JWT_SECRET || 'conclave-dev-secret-change-in-production',
};

(async () => {
  try {
    // Apply performance indexes before starting server
    await applyPerformanceIndexes();
    await startServer(config);
  } catch (err) {
    console.error('Fatal error starting Conclave:', err);
    process.exit(1);
  }
})();

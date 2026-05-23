/**
 * Conclave — Entry point
 * Starts the server when run directly.
 */

import { startServer } from './server/index.js';

const config = {
  mode: (process.env.CONCLAVE_MODE || 'local') as 'local' | 'self-hosted' | 'cloud',
  port: parseInt(process.env.CONCLAVE_PORT || '3000'),
  host: process.env.CONCLAVE_HOST || '0.0.0.0',
  database: {
    type: 'sqlite' as const,
    url: process.env.CONCLAVE_DB || './conclave-local.db',
  },
  jwtSecret: process.env.CONCLAVE_JWT_SECRET || 'conclave-dev-secret-change-in-production',
};

startServer(config).catch((err) => {
  console.error('Fatal error starting Conclave:', err);
  process.exit(1);
});
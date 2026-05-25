/**
 * Conclave — Agent Peer Protocol & Reputation System
 * Main server entry point. Starts the Fastify HTTP API server.
 * Local mode uses SQLite, self-hosted/cloud uses PostgreSQL.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { initDb, type ConclaveDb } from '../db/index.js';

import { principalRoutes } from '../routes/principals.js';
import { agentRoutes } from '../routes/agents.js';
import { taskRoutes } from '../routes/tasks.js';
import { opinionRoutes } from '../routes/opinions.js';
import { channelRoutes } from '../routes/channels.js';
import { reputationRoutes } from '../routes/reputation.js';
import { budgetRoutes } from '../routes/budget.js';
import { spotCheckRoutes } from '../routes/spot-check.js';
import { orgRoutes } from '../routes/orgs.js';
import { healthRoutes } from '../routes/health.js';
import { fleetRoutes } from '../routes/fleet.js';
import { providerRoutes } from '../routes/providers.js';
import { cronRoutes } from '../routes/cron.js';
import { authRoutes } from '../routes/auth.js';
import type { FleetManager } from '../fleet/manager.js';

export interface ConclaveConfig {
  mode: 'local' | 'self-hosted' | 'cloud';
  port: number;
  host: string;
  database: {
    url: string;  // PostgreSQL connection string
  };
  jwtSecret: string;
  rateLimit?: {
    max: number;
    timeWindow: string;
  };
}

const DEFAULT_CONFIG: ConclaveConfig = {
  mode: 'local',
  port: 3000,
  host: '0.0.0.0',
  database: {
    url: process.env.DATABASE_URL || 'postgres://localhost:5432/conclave',
  },
  jwtSecret: 'conclave-dev-secret-change-in-production',
};

export async function createServer(config: Partial<ConclaveConfig> = {}, fleetManager?: FleetManager) {
  const fullConfig: ConclaveConfig = { ...DEFAULT_CONFIG, ...config };

  // Initialize database (PG connection — async)
  const { db, client: pgClient, close: closeDb } = await initDb(fullConfig.database);

  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
    },
  });

  // Decorate fastify with db instance and raw PG client
  fastify.decorate('db', db);
  fastify.decorate('config', fullConfig);
  fastify.decorate('pgClient', pgClient);

  // CORS
  await fastify.register(cors, { origin: true });

  // Rate limiting (skip in local mode for development)
  if (fullConfig.mode !== 'local') {
    await fastify.register(rateLimit, {
      max: fullConfig.rateLimit?.max || 60,
      timeWindow: fullConfig.rateLimit?.timeWindow || '1 minute',
    });
  }

  // JWT auth (skip verification in local mode)
  await fastify.register(jwt, {
    secret: fullConfig.jwtSecret,
  });

  // Auth hook — extract agent ID from JWT or X-Agent-Id header
  // In local mode, X-Agent-Id header simulates different agents
  // In cloud mode, X-Agent-Id header is used by MCP clients and API keys
  fastify.addHook('preHandler', async (request, reply) => {
    const headerAgentId = request.headers['x-agent-id'] as string | undefined;

    if (fullConfig.mode === 'local') {
      (request as any).agentId = headerAgentId || 'agt_dev';
      (request as any).principalId = 'prn_dev';
      (request as any).adminId = 'admin_dev';
      return;
    }

    // Public routes that don't need auth
    const publicPaths = ['/health', '/v1/health', '/auth/register', '/auth/login'];
    if (publicPaths.includes(request.url)) return;

    // Cloud mode: try JWT first, then X-Agent-Id header, then anonymous
    try {
      await request.jwtVerify();
      const payload = request.user as any;
      (request as any).agentId = payload.agentId || payload.sub;
      (request as any).principalId = payload.principalId;
      (request as any).adminId = payload.adminId;
    } catch {
      // No valid JWT — fall back to X-Agent-Id header or anonymous
      (request as any).agentId = headerAgentId || 'agt_anon';
      (request as any).principalId = headerAgentId ? undefined : 'prn_anon';
    }
  });

  // Health check (no prefix)
  await fastify.register(healthRoutes);

  // Auth routes (no prefix for registration/login)
  await fastify.register(authRoutes);

  // API routes (path-based versioning: /v1/)
  await fastify.register(principalRoutes, { prefix: '/v1' });
  await fastify.register(agentRoutes, { prefix: '/v1' });
  await fastify.register(taskRoutes, { prefix: '/v1' });
  await fastify.register(opinionRoutes, { prefix: '/v1' });
  await fastify.register(channelRoutes, { prefix: '/v1' });
  await fastify.register(reputationRoutes, { prefix: '/v1' });
  await fastify.register(budgetRoutes, { prefix: '/v1' });
  await fastify.register(spotCheckRoutes, { prefix: '/v1' });
  await fastify.register(orgRoutes, { prefix: '/v1' });
  await fastify.register(providerRoutes, { prefix: '/v1' });

  // Fleet routes (only when fleet manager is provided)
  if (fleetManager) {
    await fastify.register(async (instance) => fleetRoutes(instance, fleetManager), { prefix: '/v1' });
  }

  // Cron review route
  await fastify.register(cronRoutes, { prefix: '/v1' });
  await fastify.register(vaultRoutes, { prefix: '/v1' });

  return { fastify, config: fullConfig };
}

export async function startServer(config: Partial<ConclaveConfig> = {}) {
  const { fastify, config: fullConfig } = await createServer(config);

  await fastify.listen({ port: fullConfig.port, host: fullConfig.host });

  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║         🔮 CONCLAVE v0.1.0           ║');
  console.log('  ║   Agent Peer Protocol & Reputation   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Mode:     ${fullConfig.mode}`);
  console.log(`  Database: ${fullConfig.database.url.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`  Listen:   http://${fullConfig.host}:${fullConfig.port}`);
  console.log(`  Health:   http://${fullConfig.host}:${fullConfig.port}/v1/health`);
  console.log('');

  return fastify;
}

// Augment FastifyRequest
declare module 'fastify' {
  interface FastifyInstance {
    db: ConclaveDb;
    config: ConclaveConfig;
    pgClient: any; // Raw postgres-js client for LISTEN/NOTIFY
  }
}
/**
 * Conclave — Agent Peer Protocol & Reputation System
 * Main server entry point. Starts the Fastify HTTP API server.
 * Local mode uses SQLite, self-hosted/cloud uses PostgreSQL.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import { initDb, type ConclaveDb } from '../db/index.js';
import { agents } from '../db/schema.js';
import { eq } from 'drizzle-orm';

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
import { vaultRoutes } from '../routes/vault.js';
import { apiKeyRoutes } from '../routes/api-keys.js';
import { pushRoutes } from '../routes/push.js';
import { profileRoutes } from '../routes/profiles.js';
import { pulseRoutes } from '../routes/pulse.js';
import { memoryRoutes } from '../routes/memory.js';
import { pulseHub } from '../services/pulse.js';
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
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id', 'X-Agent-Id'],
    credentials: true
  });

  // OpenAPI spec generation
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Conclave API',
        description: 'Peer review and reputation protocol for autonomous agents',
        version: '1.0.0',
      },
      servers: [{ url: '/v1', description: 'Main API server' }],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Bearer tokens: clv_ agent tokens or clv_api_ API keys',
          },
        },
      },
    },
  });

  // Rate limiting (skip in local mode for development)
  if (fullConfig.mode !== 'local') {
    await fastify.register(rateLimit, {
      max: fullConfig.rateLimit?.max || 1200,
      timeWindow: fullConfig.rateLimit?.timeWindow || '1 minute',
    });

    // Inject rate_limit_remaining into the meta envelope of every JSON response
    fastify.addHook('preSerialization', async (request, reply, payload: unknown) => {
      if (typeof payload === 'object' && payload !== null) {
        const p = payload as Record<string, unknown>;
        if (!p.meta || typeof p.meta !== 'object') {
          p.meta = {};
        }
        const remaining = reply.getHeader('x-ratelimit-remaining');
        if (remaining !== undefined) {
          (p.meta as Record<string, unknown>).rate_limit_remaining = Number(remaining);
        }
      }
      return payload;
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
    const authHeader = request.headers.authorization;
    const tokenFromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    
    console.log(`[Auth] mode=${fullConfig.mode} url=${request.url} token=${tokenFromHeader?.slice(0,10)}... headerAgentId=${headerAgentId}`);

    if (fullConfig.mode === 'local') {
      (request as any).agentId = headerAgentId || 'agt_dev';
      (request as any).principalId = 'prn_dev';
      (request as any).adminId = 'admin_dev';
      return;
    }

    // Public routes that don't need auth
    const publicPaths = ['/health', '/v1/health', '/v1/broadcast', '/v1/auth/register', '/v1/auth/login', '/auth/register', '/auth/login', '/register', '/login', '/v1/openapi.json'];
    if (publicPaths.includes(request.url)) return;

    // Cloud mode: try JWT first, then X-Agent-Id header, then anonymous
    try {
      await request.jwtVerify();
      const payload = request.user as any;
      (request as any).agentId = payload.agentId || payload.sub;
      (request as any).principalId = payload.principalId;
      (request as any).adminId = payload.adminId;
    } catch {
      // No valid JWT — try clv_ agent token lookup
      const authHeader = request.headers.authorization;
      const tokenFromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      const maybeClvToken = tokenFromHeader?.startsWith('clv_') ? tokenFromHeader : undefined;

      if (maybeClvToken) {
        try {
          const agent = await db.query.agents.findFirst({
            where: eq(agents.token, maybeClvToken),
          });
          if (agent) {
            (request as any).agentId = agent.id;
            (request as any).principalId = agent.principalId;
            (request as any).orgId = agent.orgId;
            (request as any).user = { id: agent.principalId };
            return;
          }
        } catch {
          // DB lookup failed — fall through to anonymous
        }
      }

      // Fall back to X-Agent-Id header or anonymous
      (request as any).agentId = headerAgentId || 'agt_anon';
      (request as any).principalId = headerAgentId ? undefined : 'prn_anon';
    }
  });

  // Health check (no prefix)
  await fastify.register(healthRoutes);

  // OpenAPI spec endpoint
  fastify.get('/v1/openapi.json', async (_request: any, _reply: any) => {
    return fastify.swagger();
  });

  // Public broadcast endpoint — receives events from fleet/Vercel PulseHub
  fastify.post('/v1/broadcast', async (request, reply) => {
    const { event, orgId } = request.body as any;
    if (!event || !event.type) {
      return reply.status(400).send({ error: 'Invalid event payload' });
    }
    if (orgId) {
      pulseHub.emit(`org:${orgId}`, event);
    } else {
      pulseHub.emit('global', event);
    }
    return { success: true };
  });

  // Auth routes
  await fastify.register(authRoutes, { prefix: '/v1/auth' });

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
  await fastify.register(pulseRoutes, { prefix: '/v1' });
  await fastify.register(memoryRoutes, { prefix: '/v1' });
  await fastify.register(apiKeyRoutes, { prefix: '/v1' });
  // Bare /pulse route for EventSource clients (browsers can't set custom headers)
  await fastify.register(pulseRoutes, { prefix: '' });

  // Fleet routes (only when fleet manager is provided)
    await fastify.register(fleetRoutes, { prefix: '/v1' });

  // Cron review route
  await fastify.register(cronRoutes, { prefix: '/v1' });
  await fastify.register(vaultRoutes, { prefix: '/v1' });
  await fastify.register(pushRoutes, { prefix: '/v1' });

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
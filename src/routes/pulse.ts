/**
 * Pulse SSE Route
 * Streams real-time events to the client via Server-Sent Events.
 */
import type { FastifyPluginCallback } from 'fastify';
import { pulseHub } from '../services/pulse.js';

export const pulseRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  
  fastify.get('/pulse', async (request, reply) => {
    // 1. Resolve Organization Context
    const orgId = (request as any).orgId;
    if (!orgId) {
      return reply.code(403).send({ error: 'No organization context found in session' });
    }

    // 2. Set SSE Headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // 3. Event Handler
    const handler = (event: any) => {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      reply.raw.write(data);
    };

    // Subscribe to this org's events AND global events
    pulseHub.on(`org:${orgId}`, handler);
    pulseHub.on('global', handler);

    // 4. Cleanup on disconnect
    request.raw.on('close', () => {
      pulseHub.removeListener(`org:${orgId}`, handler);
      pulseHub.removeListener('global', handler);
    });

    // Prevent Fastify from closing the connection automatically
    return reply.raw;
  });

  done();
};

/**
 * Pulse SSE Route
 * Streams real-time events to the client via Server-Sent Events.
 */
import type { FastifyPluginCallback } from 'fastify';
import { pulseHub } from '../services/pulse.js';
import { authenticate } from '../middleware/auth.js';

export const pulseRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  
  fastify.addHook('preHandler', authenticate);

  fastify.get('/pulse', async (request, reply) => {
    // 1. Resolve Organization Context
    const orgId = (request as any).orgId;
    if (!orgId) {
      return reply.code(403).send({ error: 'No organization context found in session' });
    }

    // 2. Set SSE Headers
    // We use reply.raw because SSE requires manual control over the response stream
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // 3. Event Handler
    const handler = (event: any) => {
      try {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        reply.raw.write(data);
      } catch (err) {
        console.error('[Pulse Hub] Write failed', err);
      }
    };

    // Subscribe to this org's events AND global events
    pulseHub.on(`org:${orgId}`, handler);
    pulseHub.on('global', handler);

    // 4. Cleanup on disconnect
    request.raw.on('close', () => {
      pulseHub.removeListener(`org:${orgId}`, handler);
      pulseHub.removeListener('global', handler);
    });

    // IMPORTANT: For SSE in Fastify, we must return a promise that never resolves 
    // or use a specific response pattern to prevent Fastify from closing the connection.
    // Returning a Promise that doesn't resolve is a common way to keep the stream open.
    return new Promise(() => {});
  });

  done();
};

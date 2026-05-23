/**
 * Conclave — Health check routes
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';

export const healthRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  fastify.get('/health', async () => {
    return { status: 'ok', service: 'conclave', version: '0.1.0' };
  });

  fastify.get('/v1/health', async () => {
    return {
      status: 'ok',
      service: 'conclave',
      version: '0.1.0',
      mode: 'local',
      timestamp: new Date().toISOString(),
    };
  });

  done();
};
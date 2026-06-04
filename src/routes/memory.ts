/**
 * Conclave — Memory routes
 * Exposes MemoryService via REST API for CRUD operations on principal memory.
 */

import type { FastifyInstance } from 'fastify';
import { MemoryService } from '../services/memory.js';
import { success, error } from '../utils/response.js';
import { authenticate } from '../middleware/auth.js';
import { eq } from 'drizzle-orm';
import { principalMemory } from '../db/schema.js';

const VALID_CATEGORIES = ['convention', 'preference', 'fact', 'general'] as const;

export async function memoryRoutes(fastify: FastifyInstance) {
  const db = (fastify as any).db;
  const memorySvc = new MemoryService(db);

  fastify.addHook('preHandler', authenticate);

  fastify.get('/', async (request: any, reply) => {
    const principalId = request.principalId;
    if (!principalId) return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID'));

    const { category } = request.query as { category?: string };
    if (category && !VALID_CATEGORIES.includes(category as any)) {
      return reply.code(400).send(error('VALIDATION_ERROR', 'Invalid category'));
    }

    let memories = await memorySvc.getByPrincipal(principalId);
    if (category) {
      memories = memories.filter(m => m.category === category);
    }
    return reply.send(success({ memories }));
  });

  fastify.get('/:key', async (request: any, reply) => {
    const { key } = request.params as { key: string };
    const principalId = request.principalId;
    if (!principalId) return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID'));

    const memory = await memorySvc.getByKey(principalId, key);
    if (!memory) return reply.code(404).send(error('NOT_FOUND', 'Memory not found'));

    return reply.send(success({ memory }));
  });

  fastify.post('/', async (request: any, reply) => {
    const body = request.body as { key: string; value: string; category?: string };
    const { key, value, category } = body;
    if (!key || !value) return reply.code(422).send(error('VALIDATION_ERROR', 'key and value required'));

    const principalId = request.principalId;
    if (!principalId) return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID'));

    const result = await memorySvc.upsert({ principalId, key, value, category });
    return reply.send(success({ memory: result }));
  });

  fastify.delete('/:key', async (request: any, reply) => {
    const { key } = request.params as { key: string };
    const principalId = request.principalId;
    if (!principalId) return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID'));

    const deleted = await memorySvc.delete(principalId, key);
    if (!deleted) return reply.code(404).send(error('NOT_FOUND', 'Memory not found'));

    return reply.send(success({ deleted: true }));
  });

  fastify.post('/search', async (request: any, reply) => {
    const body = request.body as { query: string; limit?: number };
    const { query, limit } = body;
    if (!query || query.trim().length < 2) return reply.code(422).send(error('VALIDATION_ERROR', 'query too short'));

    const principalId = request.principalId;
    if (!principalId) return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID'));

    const results = await memorySvc.search(principalId, query, limit || 20);
    return reply.send(success({ memories: results, count: results.length }));
  });

  fastify.get('/stats', async (request: any, reply) => {
    const principalId = request.principalId;
    if (!principalId) return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID'));

    const stats = await memorySvc.getStats(principalId);
    return reply.send(success({ stats }));
  });

  fastify.post('/cleanup', async (_request: any, reply) => {
    const deletedCount = await memorySvc.cleanupExpired();
    return reply.send(success({ deleted: deletedCount }));
  });
}
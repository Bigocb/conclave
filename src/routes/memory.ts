/**
 * Conclave — Memory routes
 * Exposes MemoryService via REST API for CRUD operations on principal memory.
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { MemoryService } from '../services/memory.js';
import { success, error } from '../utils/response.js';
import { authenticate } from '../middleware/auth.js';
import { eq } from 'drizzle-orm';
import { principalMemory } from '../db/schema.js';

const VALID_CATEGORIES = ['convention', 'preference', 'fact', 'general'] as const;

export const memoryRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  const db = (fastify as any).db;
  const memorySvc = new MemoryService(db);

  // Protect all memory routes with authentication
  fastify.addHook('preHandler', authenticate);

  // GET /v1/memory — List all memories for authenticated principal
  fastify.get('/', async (request: any, reply) => {
    const principalId = request.principalId;
    if (!principalId) {
      return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID in request'));
    }

    const { category } = request.query as { category?: string };

    // Validate category if provided
    if (category && !VALID_CATEGORIES.includes(category as any)) {
      return reply.code(400).send(error('VALIDATION_ERROR', `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`));
    }

    // Filter by category if provided, otherwise return all
    let memories;
    if (category) {
      memories = await db.select()
        .from(principalMemory)
        .where(eq(principalMemory.principalId, principalId));
      memories = memories.filter((m: typeof principalMemory.$inferSelect) => m.category === category);
    } else {
      memories = await memorySvc.getByPrincipal(principalId);
    }

    return reply.send(success({ memories }));
  });

  // GET /v1/memory/:key — Get single memory entry
  fastify.get('/:key', async (request: any, reply) => {
    const { key } = request.params as { key: string };
    const principalId = request.principalId;
    if (!principalId) {
      return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID in request'));
    }

    const memory = await memorySvc.getByKey(principalId, key);
    if (!memory) {
      return reply.code(404).send(error('NOT_FOUND', 'Memory not found'));
    }

    return reply.send(success({ memory }));
  });

  // POST /v1/memory — Create or update memory entry
  fastify.post('/', async (request: any, reply) => {
    const body = request.body as { key: string; value: string; category?: string };
    const { key, value, category } = body;

    if (!key || !value) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'key and value are required'));
    }

    const principalId = request.principalId;
    if (!principalId) {
      return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID in request'));
    }

    const result = await memorySvc.upsert({
      principalId,
      key,
      value,
      category,
    });

    return reply.send(success({ memory: result }));
  });

  // DELETE /v1/memory/:key — Delete memory entry
  fastify.delete('/:key', async (request: any, reply) => {
    const { key } = request.params as { key: string };
    const principalId = request.principalId;
    if (!principalId) {
      return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID in request'));
    }

    const deleted = await memorySvc.delete(principalId, key);
    if (!deleted) {
      return reply.code(404).send(error('NOT_FOUND', 'Memory not found'));
    }

    return reply.send(success({ deleted: true }));
  });

  done();
};

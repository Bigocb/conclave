/**
 * Conclave — Memory routes
 * Exposes MemoryService via REST API for CRUD operations on principal memory.
 */

import type { FastifyInstance } from 'fastify';
import { MemoryService } from '../services/memory.js';
import { success, error } from '../utils/response.js';
import { authenticate } from '../middleware/auth.js';

const VALID_CATEGORIES = ['convention', 'preference', 'fact', 'general'] as const;

export async function memoryRoutes(fastify: FastifyInstance) {
  const memorySvc = new MemoryService((fastify as any).db);

  // Protect all memory routes with authentication
  fastify.addHook('preHandler', authenticate);

  // IMPORTANT: More specific routes must come BEFORE parameterized routes.
  // /memory/search, /memory/stats, /memory/cleanup must precede /memory/:key.

  // GET /v1/memory — List all memories for authenticated principal
  fastify.get('/memory', async (request: any, reply) => {
    const principalId = request.principalId;
    if (!principalId) {
      return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID in request'));
    }

    const { category } = request.query as { category?: string };

    // Validate category if provided
    if (category && !VALID_CATEGORIES.includes(category as any)) {
      return reply.code(400).send(error('VALIDATION_ERROR', `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`));
    }

    let memories = await memorySvc.getByPrincipal(principalId);
    if (category) {
      memories = memories.filter((m: any) => m.category === category);
    }

    return reply.send(success({ memories }));
  });

  // GET /v1/memory/search — Search memories (text/pattern search using ILIKE)
  fastify.get('/memory/search', async (request: any, reply) => {
    const { q, category, limit, includeExpired } = request.query as {
      q?: string;
      category?: string;
      limit?: string;
      includeExpired?: string;
    };

    const principalId = request.principalId;
    if (!principalId) {
      return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID in request'));
    }

    // Validate category if provided
    if (category && !VALID_CATEGORIES.includes(category as any)) {
      return reply.code(400).send(error('VALIDATION_ERROR', `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`));
    }

    let results = await memorySvc.search(principalId, q || '', limit ? parseInt(limit, 10) : 20);
    if (category) {
      results = results.filter((m: any) => m.category === category);
    }
    if (includeExpired !== 'true') {
      const now = new Date().toISOString();
      results = results.filter((m: any) => !m.expiresAt || m.expiresAt >= now);
    }

    return reply.send(success({ memories: results, count: results.length }));
  });

  // GET /v1/memory/stats — Get memory statistics
  fastify.get('/memory/stats', async (request: any, reply) => {
    const principalId = request.principalId;
    if (!principalId) {
      return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID in request'));
    }

    const stats = await memorySvc.getStats(principalId);
    return reply.send(success({ stats }));
  });

  // GET /v1/memory/:key — Get single memory entry (must be AFTER /search, /stats)
  fastify.get('/memory/:key', async (request: any, reply) => {
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
  fastify.post('/memory', async (request: any, reply) => {
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

  // POST /v1/memory/search — Search via POST (alternative)
  fastify.post('/memory/search', async (request: any, reply) => {
    const { query, category, limit, includeExpired } = request.body as {
      query: string;
      category?: string;
      limit?: number;
      includeExpired?: boolean;
    };

    const principalId = request.principalId;
    if (!principalId) {
      return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID in request'));
    }

    if (!query || query.trim().length < 2) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'query must be at least 2 characters'));
    }

    let results = await memorySvc.search(principalId, query, limit || 20);
    if (category) {
      results = results.filter((m: any) => m.category === category);
    }
    if (!includeExpired) {
      const now = new Date().toISOString();
      results = results.filter((m: any) => !m.expiresAt || m.expiresAt >= now);
    }

    return reply.send(success({ memories: results, count: results.length }));
  });

  // POST /v1/memory/cleanup — Cleanup expired memories
  fastify.post('/memory/cleanup', async (request: any, reply) => {
    const principalId = request.principalId;
    if (!principalId) {
      return reply.code(401).send(error('UNAUTHORIZED', 'No principal ID in request'));
    }

    const deletedCount = await memorySvc.cleanupExpired();
    return reply.send(success({ deletedCount }));
  });

  // DELETE /v1/memory/:key — Delete memory entry
  fastify.delete('/memory/:key', async (request: any, reply) => {
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
}
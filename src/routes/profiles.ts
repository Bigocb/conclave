
/**
 * Conclave — Agent Profile API
 * Manages the blueprints used by both fleet and standalone agents.
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { agentProfiles } from '../db/schema.js'; // I will need to ensure this is in schema.ts
import { success, error } from '../utils/response.js';

export async function profileRoutes(fastify: FastifyInstance) {
  
  /**
   * GET /v1/profiles
   * Lists all la- laavailable agent blueprints.
   */
  fastify.get('/profiles', async (request, reply) => {
    const { orgId } = request.query as any;
    if (!orgId) return reply.code(400).send(error('VALIDATION_ERROR', 'orgId is required'));

    const profiles = await fastify.db.query.agentProfiles.findMany({
      where: eq(agentProfiles.orgId, orgId),
    });

    reply.send(success({ profiles, total: profiles.length }));
  });

  /**
   * POST /v1/profiles
   * Creates a new agent blueprint.
   */
  fastify.post('/profiles', async (request, reply) => {
    const body = request.body as any;
    const { orgId, name, model, provider, instructions, skills } = body;

    if (!orgId || !name) {
      return reply.code(400).send(error('VALIDATION_ERROR', 'orgId and name are required'));
    }

    const result = await fastify.db.insert(agentProfiles).values({
      orgId,
      name,
      model: model || null,
      provider: provider || null,
      instructions: instructions || null,
      skills: typeof skills === 'string' ? skills : (skills ? JSON.stringify(skills) : null),
      temperature: body.temperature || 0.3,
    }).returning();

    reply.code(201).send(success(result[0]));
  });

  /**
   * PATCH /v1/profiles/:id
   * Updates an existing blueprint.
   */
  fastify.patch('/profiles/:id', async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as any;

    if (!id) return reply.code(400).send(error('VALIDATION_ERROR', 'profile id is required'));

    const updates: any = {};
    if (body.name) updates.name = body.name;
    if (body.model) updates.model = body.model;
    if (body.provider) updates.provider = body.provider;
    if (body.instructions) updates.instructions = body.instructions;
    if (body.skills) updates.skills = typeof body.skills === 'string' ? body.skills : (skills ? JSON.stringify(skills) : null);
    if (body.temperature !== undefined) updates.temperature = body.temperature;

    const result = await fastify.db.update(agentProfiles)
      .set(updates)
      .where(eq(agentProfiles.id, id))
      .returning();

    if (result.length === 0) {
      return reply.code(404).send(error('NOT_FOUND', 'Profile not found'));
    }

    reply.send(success(result[0]));
  });

  /**
   * DELETE /v1/profiles/:id
   * Removes a blueprint.
   */
  fastify.delete('/profiles/:id', async (request, reply) => {
    const { id } = request.params as any;
    if (!id) return reply.code(400).send(error('VALIDATION_ERROR', 'profile id is required'));

    const result = await fastify.db.delete(agentProfiles).where(eq(agentProfiles.id, id)).returning();

    if (result.length === 0) {
      return reply.code(404).send(error('NOT_FOUND', 'Profile not found'));
    }

    reply.send(success({ id, status: 'deleted' }));
  });
}

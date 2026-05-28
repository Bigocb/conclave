/**
 * Conclave — Fleet Management API
 * Implements CRUD operations for fleet configuration and reviewers.
 */

import { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { fleetConfig, fleetReviewers } from '../db/schema.js';
import { success, error } from '../utils/response.js';
import { VaultService } from '../services/vault.js';

export async function fleetRoutes(fastify: FastifyInstance) {
  const vault = new VaultService(fastify.db);

  /**
   * GET /v1/fleet/config
   * Retrieves the global fleet configuration for the organization.
   * Note: In a real multi-tenant scenario, orgId would come from the auth token.
   * For now, we assume a system-level or specific org context.
   */
  fastify.get('/fleet/config', async (request, reply) => {
    const { orgId } = request.query as any;

    if (!orgId) {
      return reply.code(400).send(error('VALIDATION_ERROR', 'orgId is required'));
    }

    const config = await fastify.db.query.fleetConfig.findFirst({
      where: eq(fleetConfig.orgId, orgId),
    });

    if (!config) {
      return reply.code(404).send(error('NOT_FOUND', 'Fleet configuration not found for this organization'));
    }

    reply.send(success(config));
  });

  /**
   * PATCH /v1/fleet/config
   * Updates global fleet settings.
   */
  fastify.patch('/fleet/config', async (request, reply) => {
    const { orgId } = request.query as any;
    const body = request.body as any;

    if (!orgId) return reply.code(400).send(error('VALIDATION_ERROR', 'orgId is required'));

    const updates: any = {};
    if (body.server) updates.server = body.server;
    if (body.scope) updates.scope = body.scope;
    if (body.providers) {
      updates.providers = JSON.stringify(body.providers);
    }
    updates.updatedAt = new Date().toISOString();

    const result = await fastify.db.update(fleetConfig)
      .set(updates)
      .where(eq(fleetConfig.orgId, orgId))
      .returning();

    if (result.length === 0) {
      return reply.code(404).send(error('NOT_FOUND', 'Fleet configuration not found'));
    }

    reply.send(success(result[0]));
  });

  /**
   * GET /v1/fleet/reviewers
   * Lists all reviewer blueprints for an organization.
   */
  fastify.get('/fleet/reviewers', async (request, reply) => {
    const { orgId } = request.query as any;
    if (!orgId) return reply.code(400).send(error('VALIDATION_ERROR', 'orgId is required'));

    const reviewers = await fastify.db.query.fleetReviewers.findMany({
      where: eq(fleetReviewers.orgId, orgId),
    });

    reply.send(success({ reviewers, total: reviewers.length }));
  });

  /**
   * POST /v1/fleet/reviewers
   * Creates a new reviewer blueprint.
   */
  fastify.post('/fleet/reviewers', async (request, reply) => {
    const body = request.body as any;
    const { orgId, name, channels, type, model, provider, llmUrl, llmKey, command, replicas, mode, confidenceThreshold, prompt, instructions, skills, steps, interval, maxConcurrent } = body;

    if (!orgId || !name || !channels) {
      return reply.code(400).send(error('VALIDATION_ERROR', 'orgId, name, and channels are required'));
    }

    let encryptedKey = null;
    if (llmKey) {
      // Store the sensitive key in the vault
      await vault.upsertKey(orgId, `${provider || 'fleet-reviewer'}_${name}`, llmKey);
      encryptedKey = `${provider || 'fleet-reviewer'}_${name}`;
    }

    const id = `rev_blueprint_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const result = await fastify.db.insert(fleetReviewers).values({
      id,
      orgId,
      name,
      channels: typeof channels === 'string' ? channels : JSON.stringify(channels),
      type: type || 'llm',
      model: model || null,
      provider: provider || null,
      llmUrl: llmUrl || null,
      llmKey: encryptedKey,
      command: command || null,
      replicas: replicas || 1,
      mode: mode || 'auto',
      confidenceThreshold: confidenceThreshold || 8,
      prompt: prompt || null,
      instructions: instructions || null,
      skills: typeof skills === 'string' ? skills : (skills ? JSON.stringify(skills) : null),
      steps: typeof steps === 'string' ? steps : (steps ? JSON.stringify(steps) : null),
      interval: interval || null,
      maxConcurrent: maxConcurrent || 1,
      createdAt: now,
      updatedAt: now,
    }).returning();

    reply.code(201).send(success(result[0]));
  });

  /**
   * PATCH /v1/fleet/reviewers/:id
   * Updates an existing reviewer blueprint.
   */
  fastify.patch('/fleet/reviewers/:id', async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as any;

    if (!id) return reply.code(400).send(error('VALIDATION_ERROR', 'reviewer id is required'));

    const updates: any = {};
    if (body.name) updates.name = body.name;
    if (body.channels) updates.channels = typeof body.channels === 'string' ? body.channels : JSON.stringify(body.channels);
    if (body.type) updates.type = body.type;
    if (body.model) updates.model = body.model;
    if (body.provider) updates.provider = body.provider;
    if (body.llmUrl) updates.llmUrl = body.llmUrl;
    if (body.command) updates.command = body.command;
    if (body.replicas !== undefined) updates.replicas = body.replicas;
    if (body.mode) updates.mode = body.mode;
    if (body.confidenceThreshold !== undefined) updates.confidenceThreshold = body.confidenceThreshold;
    if (body.prompt) updates.prompt = body.prompt;
    if (body.instructions) updates.instructions = body.instructions;
    if (body.skills) updates.skills = typeof body.skills === 'string' ? body.skills : JSON.stringify(body.skills);
    if (body.steps) updates.steps = typeof body.steps === 'string' ? body.steps : JSON.stringify(body.steps);
    if (body.interval !== undefined) updates.interval = body.interval;
    if (body.maxConcurrent !== undefined) updates.maxConcurrent = body.maxConcurrent;
    
    if (body.llmKey) {
      const orgId = (await fastify.db.query.fleetReviewers.findFirst({ where: eq(fleetReviewers.id, id) }))?.orgId;
      if (orgId) {
        await vault.upsertKey(orgId, `${body.provider || 'fleet-reviewer'}_${body.name || 'unknown'}`, body.llmKey);
        updates.llmKey = `${body.provider || 'fleet-reviewer'}_${body.name || 'unknown'}`;
      }
    }

    updates.updatedAt = new Date().toISOString();

    const result = await fastify.db.update(fleetReviewers)
      .set(updates)
      .where(eq(fleetReviewers.id, id))
      .returning();

    if (result.length === 0) {
      return reply.code(404).send(error('NOT_FOUND', 'Reviewer blueprint not found'));
    }

    reply.send(success(result[0]));
  });

  /**
   * DELETE /v1/fleet/reviewers/:id
   * Removes a reviewer blueprint.
   */
  fastify.delete('/fleet/reviewers/:id', async (request, reply) => {
    const { id } = request.params as any;
    if (!id) return reply.code(400).send(error('VALIDATION_ERROR', 'reviewer id is required'));

    const result = await fastify.db.delete(fleetReviewers)
      .where(eq(fleetReviewers.id, id))
      .returning();

    if (result.length === 0) {
      return reply.code(404).send(error('NOT_FOUND', 'Reviewer blueprint not found'));
    }

    reply.send(success({ id, status: 'deleted' }));
  });

  /**
   * GET /v1/fleet/status
   * Provides high-level health and metrics for the War Room.
   */
  fastify.get('/fleet/status', async (request, reply) => {
    const { orgId } = request.query as any;
    if (!orgId) return reply.code(400).send(error('VALIDATION_ERROR', 'orgId is required'));

    const config = await fastify.db.query.fleetConfig.findFirst({
      where: eq(fleetConfig.orgId, orgId),
    });

    const reviewers = await fastify.db.query.fleetReviewers.findMany({
      where: eq(fleetReviewers.orgId, orgId),
    });

    // We'll calculate basic metrics from the current database state
    // Since we are in the API, we don't have the live memory of the FleetManager,
    // but we can return the target configuration and basic stats.
    reply.send(success({
      satellite: config ? 'ONLINE' : 'OFFLINE',
      metrics: {
        activeReviewers: reviewers.length,
        totalReplicas: reviewers.reduce((acc, curr) => acc + (curr.replicas || 0), 0),
      },
      fleet: reviewers.map(r => ({
        name: r.name,
        replicas: r.replicas,
        channel: r.channel
      }))
    }));
  });

}
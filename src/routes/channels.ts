/**
 * Conclave — Channel routes
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { CreateChannelSchema } from '../schemas/index.js';
import { ChannelService } from '../services/channels.js';
import { AgentService } from '../services/agents.js';
import { success, error, ERROR_CODES } from '../utils/response.js';

export const channelRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  const db = fastify.db;
  const channelSvc = new ChannelService(db);
  const agentSvc = new AgentService(db);

  fastify.get('/channels', async (_request, reply) => {
    const channels = await channelSvc.list();
    reply.send(success({ channels, total: channels.length }));
  });

  fastify.get('/channels/:name', async (request: any, reply) => {
    const { name } = request.params as { name: string };
    const channel = await channelSvc.getByName(name);
    if (!channel) return reply.code(404).send(error(ERROR_CODES.CHANNEL_NOT_FOUND.code, 'Channel not found'));
    reply.send(success(channel));
  });

  fastify.post('/channels', async (request, reply) => {
    const parsed = CreateChannelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send(error('VALIDATION_ERROR', 'Invalid input', parsed.error.flatten()));
    }
    const channel = await channelSvc.create({
      name: parsed.data.name,
      description: parsed.data.description,
      defaultDimensions: parsed.data.default_dimensions,
    });
    reply.code(201).send(success(channel));
  });

  fastify.post('/channels/:name/subscribe', async (request: any, reply) => {
    const { name } = request.params as { name: string };
    const channel = await channelSvc.getByName(name);
    if (!channel) return reply.code(404).send(error(ERROR_CODES.CHANNEL_NOT_FOUND.code, 'Channel not found'));
    const agentId = request.agentId ?? 'agt_dev';
    // Resolve principal from agent
    const agent = await agentSvc.getById(agentId);
    const principalId = agent?.principal_id ?? (request as any).principalId ?? 'prn_dev';
    await channelSvc.subscribe(principalId, channel.id);
    reply.send(success({ subscribed: true, channel: name, principal_id: principalId }));
  });

  fastify.delete('/channels/:name/subscribe', async (request: any, reply) => {
    const { name } = request.params as { name: string };
    const channel = await channelSvc.getByName(name);
    if (!channel) return reply.code(404).send(error(ERROR_CODES.CHANNEL_NOT_FOUND.code, 'Channel not found'));
    const agentId = request.agentId ?? 'agt_dev';
    const agent = await agentSvc.getById(agentId);
    const principalId = agent?.principal_id ?? (request as any).principalId ?? 'prn_dev';
    await channelSvc.unsubscribe(principalId, channel.id);
    reply.send(success({ subscribed: false, channel: name, principal_id: principalId }));
  });

  // GET /channels/:name/subscribers — list who's subscribed
  fastify.get('/channels/:name/subscribers', async (request: any, reply) => {
    const { name } = request.params as { name: string };
    const channel = await channelSvc.getByName(name);
    if (!channel) return reply.code(404).send(error(ERROR_CODES.CHANNEL_NOT_FOUND.code, 'Channel not found'));
    const subscribers = await channelSvc.getSubscribers(channel.id);
    reply.send(success({ channel: name, subscribers, total: subscribers.length }));
  });

  fastify.get('/channels/:name/feed', async (request: any, reply) => {
    const { name } = request.params as { name: string };
    const limit = parseInt((request.query as any).limit ?? '20');
    const feed = await channelSvc.getFeed(name, limit);
    reply.send(success(feed));
  });

  done();
};
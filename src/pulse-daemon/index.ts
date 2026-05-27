/**
 * Conclave Pulse Daemon
 * Dedicated persistent server for real-time event streaming.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { EventEmitter } from 'node:events';

export interface PulseEvent {
  type: string;
  payload: any;
  orgId?: string;
}

class PulseHub extends EventEmitter {
  broadcastToOrg(orgId: string, event: any) {
    this.emit(`org:${orgId}`, { ...event, orgId });
  }

  broadcastGlobal(event: any) {
    this.emit('global', event);
  }
}
const pulseHub = new PulseHub();

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: '*' });

// 1. The SSE Stream Endpoint
fastify.get('/pulse', async (request, reply) => {
  const orgId = (request.query as any)?.orgId;
  if (!orgId) {
    return reply.status(400).send({ error: 'orgId is required for pulse subscription' });
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const handler = (event: any) => {
    try {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      console.error('[Pulse Daemon] Write failed', err);
    }
  };

  pulseHub.on(`org:${orgId}`, handler);
  pulseHub.on('global', handler);

  request.raw.on('close', () => {
    pulseHub.removeListener(`org:${orgId}`, handler);
    pulseHub.removeListener('global', handler);
  });

  return new Promise(() => {});
});

// 2. The Internal Trigger Endpoint
fastify.post('/broadcast', async (request, reply) => {
  const { event, orgId } = request.body as any;
  
  if (!event || !event.type) {
    return reply.status(400).send({ error: 'Invalid event payload' });
  }

  if (orgId) {
    pulseHub.broadcastToOrg(orgId, event);
  } else {
    pulseHub.broadcastGlobal(event);
  }

  return { success: true };
});

const start = async () => {
  try {
    await fastify.listen({ port: 3001, host: '0.0.0.0' });
    console.log('🚀 Pulse Daemon running on port 3001');
  } catch (err) {
    console.error('Error starting Pulse Daemon:', err);
    process.exit(1);
  }
};

start();

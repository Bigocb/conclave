/**
 * Pulse WebSocket Route
 * Handles real-time connection and org-based subscription.
 */
import type { FastifyPluginCallback } from 'fastify';
import { pulseHub } from '../services/pulse.js';
import WebSocket from 'ws';

export const pulseRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  
  fastify.get('/pulse', { 
    websocket: true 
  } as any, async (connection: any, req: any) => {
    const socket = connection.socket;
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      socket.close(1008);
      return;
    }

    try {
      const token = authHeader.slice(7);
      let orgId: string | undefined;

      if (token.startsWith('clv_')) {
        const db = (fastify as any).db;
        const agent = await db.query.agents.findFirst({
          where: (agents: any, { eq }: any) => eq(agents.token, token),
        });
        if (!agent) throw new Error('Invalid agent token');
        orgId = agent.orgId;
      } else {
        throw new Error('JWT auth not implemented for WS yet');
      }

      if (orgId) {
        pulseHub.register(orgId, socket);
        
        socket.on('close', () => {
          // Cleanup handled by PulseHub
        });
      } else {
        socket.close(1008);
      }
    } catch (err) {
      socket.close(1008);
    }
  });

  done();
};

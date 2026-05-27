/**
 * Conclave Pulse Hub
 * Manages real-time WebSocket connections and event broadcasting.
 */
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

export interface PulseEvent {
  type: string;
  payload: any;
  orgId?: string;
}

export class PulseHub extends EventEmitter {
  private connections = new Map<string, Set<WebSocket>>();

  /**
   * Register a connection to an organization's event stream.
   */
  register(orgId: string, socket: WebSocket) {
    if (!this.connections.has(orgId)) {
      this.connections.set(orgId, new Set());
    }
    this.connections.get(orgId)!.add(socket);

    socket.on('close', () => {
      this.connections.get(orgId)?.delete(socket);
      if (this.connections.get(orgId)?.size === 0) {
        this.connections.delete(orgId);
      }
    });
  }

  /**
   * Broadcast an event to all clients in a specific organization.
   */
  broadcastToOrg(orgId: string, event: Omit<PulseEvent, 'orgId'>) {
    const payload = JSON.stringify({ ...event, orgId });
    const clients = this.connections.get(orgId);
    if (!clients) return;

    clients.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    });
  }

  /**
   * Broadcast an event to all connected clients regardless of org.
   */
  broadcastGlobal(event: PulseEvent) {
    const payload = JSON.stringify(event);
    this.connections.forEach(clients => {
      clients.forEach(socket => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      });
    });
  }
}

export const pulseHub = new PulseHub();

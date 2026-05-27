/**
 * Conclave Pulse Hub (SSE Edition)
 * Manages Server-Sent Events for real-time updates.
 */
import { EventEmitter } from 'node:events';

export interface PulseEvent {
  type: string;
  payload: any;
  orgId?: string;
}

class PulseHub extends EventEmitter {
  // Since SSE is request-based, we don't store socket connections.
  // Instead, we act as a central dispatcher that the route handlers
  // listen to via the EventEmitter.

  broadcastToOrg(orgId: string, event: Omit<PulseEvent, 'orgId'>) {
    this.emit(`org:${orgId}`, { ...event, orgId });
  }

  broadcastGlobal(event: PulseEvent) {
    this.emit('global', event);
  }
}

export const pulseHub = new PulseHub();

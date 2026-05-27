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

export class PulseHub extends EventEmitter {
  private pulseUrl: string = process.env.PULSE_DAEMON_URL || '';

  async broadcastToOrg(orgId: string, event: Omit<PulseEvent, 'orgId'>) {
    if (!this.pulseUrl) {
      console.error('[PulseHub] CRITICAL: PULSE_DAEMON_URL is NOT configured in Vercel environment variables.');
      return;
    }

    try {
      console.log(`[PulseHub] Attempting to relay event to ${this.pulseUrl} for org ${orgId}...`);
      const response = await fetch(`${this.pulseUrl}/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, event }),
      });
      
      if (!response.ok) {
        console.error(`[PulseHub] Render Daemon returned error: ${response.status} ${response.statusText}`);
      } else {
        console.log(`[PulseHub] Successfully relayed event to Render Daemon.`);
      }
    } catch (err) {
      console.error('[PulseHub] Network error while relaying to daemon:', err);
    }
  }

  async broadcastGlobal(event: PulseEvent) {
    if (!this.pulseUrl) {
      console.error('[PulseHub] CRITICAL: PULSE_DAEMON_URL is NOT configured in Vercel environment variables.');
      return;
    }

    try {
      console.log(`[PulseHub] Attempting to relay global event to ${this.pulseUrl}...`);
      const response = await fetch(`${this.pulseUrl}/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event }),
      });
      
      if (!response.ok) {
        console.error(`[PulseHub] Render Daemon returned error: ${response.status} ${response.statusText}`);
      } else {
        console.log(`[PulseHub] Successfully relayed global event to Render Daemon.`);
      }
    } catch (err) {
      console.error('[PulseHub] Network error while relaying to daemon:', err);
    }
  }
}

export const pulseHub = new PulseHub();

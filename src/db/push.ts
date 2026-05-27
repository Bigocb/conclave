/**
 * Conclave — Push subscription storage
 * Stores Web Push subscriptions keyed by agent ID for PWA notifications.
 */

import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const pushSubscriptions = pgTable('clv_push_subscriptions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().unique(),
  subscription: text('subscription').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

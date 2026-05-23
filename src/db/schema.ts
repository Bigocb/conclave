/**
 * Conclave — Drizzle ORM Schema (SQLite dialect)
 * Maps all tables from schema.sql — now includes Principals layer
 */

import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// ─── Organizations ──────────────────────────────────────────────
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),               // org_<uuidv7>
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  policies: text('policies'),                 // JSON
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Principals (durable identity layer) ──────────────────────
export const principals = sqliteTable('principals', {
  id: text('id').primaryKey(),               // prn_<uuidv7>
  orgId: text('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  roles: text('roles'),                        // JSON array
  capabilities: text('capabilities'),           // JSON array
  metadata: text('metadata'),                   // JSON object
  status: text('status').notNull().default('active'), // active | decommissioned
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Agents (ephemeral instances under a principal) ────────────
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),                // agt_<uuidv7>
  principalId: text('principal_id').notNull().references(() => principals.id),
  orgId: text('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  model: text('model'),
  token: text('token').notNull().unique(),
  status: text('status').notNull().default('active'), // active | decommissioned
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Attention Budgets (owned by principals) ────────────────────
export const attentionBudgets = sqliteTable('attention_budgets', {
  principalId: text('principal_id').primaryKey().references(() => principals.id),
  earned: integer('earned').notNull().default(15),
  spent: integer('spent').notNull().default(0),
  earnRate: integer('earn_rate').notNull().default(5),
  lastEarnAt: text('last_earn_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Budget History ─────────────────────────────────────────────
export const budgetHistory = sqliteTable('budget_history', {
  id: text('id').primaryKey(),                  // bhd_<uuidv7>
  principalId: text('principal_id').notNull().references(() => principals.id),
  action: text('action').notNull(),
  amount: integer('amount').notNull(),
  relatedId: text('related_id'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Channels ───────────────────────────────────────────────────
export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),                  // ch_<uuidv7>
  name: text('name').notNull().unique(),
  description: text('description'),
  defaultDimensions: text('default_dimensions'), // JSON array
  createdByOrg: text('created_by_org').references(() => organizations.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Channel Subscriptions (principals subscribe) ──────────────
export const channelSubscriptions = sqliteTable('channel_subscriptions', {
  principalId: text('principal_id').notNull().references(() => principals.id),
  channelId: text('channel_id').notNull().references(() => channels.id),
  subscribedAt: text('subscribed_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Tasks ──────────────────────────────────────────────────────
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),                  // tsk_<uuidv7>
  agentId: text('agent_id').notNull().references(() => agents.id),
  principalId: text('principal_id').notNull().references(() => principals.id),
  description: text('description').notNull(),
  dimensions: text('dimensions').notNull(),      // JSON array
  output: text('output').notNull(),
  outputFormat: text('output_format').default('markdown'),
  channel: text('channel').notNull(),
  requestedReviews: integer('requested_reviews').notNull().default(3),
  deadline: text('deadline'),
  priority: text('priority').notNull().default('normal'),
  status: text('status').notNull().default('open'),
  metadata: text('metadata'),                    // JSON
  budgetSpent: integer('budget_spent').notNull().default(5),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Reviews ────────────────────────────────────────────────────
export const reviews = sqliteTable('reviews', {
  id: text('id').primaryKey(),                  // rev_<uuidv7>
  taskId: text('task_id').notNull().references(() => tasks.id),
  reviewerId: text('reviewer_id').notNull().references(() => agents.id),
  principalId: text('principal_id').notNull().references(() => principals.id),
  scores: text('scores').notNull(),               // JSON object { dimension: score }
  weightedOverall: real('weighted_overall').notNull(),
  reviewerConfidence: real('reviewer_confidence').notNull(),
  comment: text('comment').notNull(),
  suggestions: text('suggestions'),                // JSON array
  approved: integer('approved').notNull().default(0), // 0 or 1
  helpful: integer('helpful'),                         // null | 0 | 1
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Opinions ───────────────────────────────────────────────────
export const opinions = sqliteTable('opinions', {
  id: text('id').primaryKey(),                  // opn_<uuidv7>
  agentId: text('agent_id').notNull().references(() => agents.id),
  principalId: text('principal_id').notNull().references(() => principals.id),
  question: text('question').notNull(),
  context: text('context'),
  channel: text('channel').notNull(),
  requestedOpinions: integer('requested_opinions').notNull().default(3),
  deadline: text('deadline'),
  metadata: text('metadata'),                    // JSON
  budgetSpent: integer('budget_spent').notNull().default(3),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Opinion Responses ──────────────────────────────────────────
export const opinionResponses = sqliteTable('opinion_responses', {
  id: text('id').primaryKey(),                   // rsp_<uuidv7>
  opinionId: text('opinion_id').notNull().references(() => opinions.id),
  respondentId: text('respondent_id').notNull().references(() => agents.id),
  principalId: text('principal_id').notNull().references(() => principals.id),
  response: text('response').notNull(),
  confidence: real('confidence').notNull(),
  reasoning: text('reasoning'),
  references: text('references'),                 // JSON array
  metadata: text('metadata'),                     // JSON
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Reputation Snapshots (owned by principals) ────────────────
export const reputationSnapshots = sqliteTable('reputation_snapshots', {
  id: text('id').primaryKey(),
  principalId: text('principal_id').notNull().references(() => principals.id),
  performerOverall: real('performer_overall'),
  performerDimensions: text('performer_dimensions'),   // JSON
  performerByRole: text('performer_by_role'),            // JSON
  reviewerOverall: real('reviewer_overall'),
  reviewerAlignment: real('reviewer_alignment'),
  reviewerHelpfulness: real('reviewer_helpfulness'),
  reviewCount: integer('review_count').notNull().default(0),
  taskCount: integer('task_count').notNull().default(0),
  confidence: real('confidence').notNull().default(0),
  trend: text('trend'),
  snapshotAt: text('snapshot_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Spot Checks ────────────────────────────────────────────────
export const spotChecks = sqliteTable('spot_checks', {
  id: text('id').primaryKey(),
  reviewId: text('review_id').notNull().references(() => reviews.id),
  adminId: text('admin_id').notNull(),
  accuracy: integer('accuracy').notNull(),
  fairness: integer('fairness').notNull(),
  comment: text('comment'),
  dimensionsOverride: text('dimensions_override'), // JSON
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});
import { pgTable, text, integer, doublePrecision, index } from 'drizzle-orm/pg-core';

// ─── Users ──────────────────────────────────────────────────
export const users = pgTable('clv_users', {
  id: text('id').primaryKey(),               // usr_<uuidv7>
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),       // Null for OAuth users
  fullSName: text('full_name'),
  avatarUrl: text('avatar_url'),
  googleId: text('google_id').unique(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString()),
});

// ─── Organizations (The Workspace/Org merged entity) ───────────
export const organizations = pgTable('clv_organizations', {
  id: text('id').primaryKey(),               // org_<uuidv7>
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  policies: text('policies'),                 // JSON
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString()),
});

// ─── User Organization Memberships ─────────────────────────────
export const organizationMembers = pgTable('clv_org_members', {
  orgId: text('org_id').notNull().references(() => organizations.id),
  userId: text('user_id').notNull().references(() => users.id),
  role: text('role').notNull().default('member'), // owner | admin | member
  joinedAt: text('joined_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  orgUserIdx: index('idx_org_members_org_user').on(table.orgId, table.userId),
}));

// ─── Principals (durable identity layer) ────────────────────
export const principals = pgTable('clv_principals', {
  id: text('id').primaryKey(),               // prn_<uuidv7>
  orgId: text('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  roles: text('roles'),                        // JSON array
  capabilities: text('capabilities'),           // JSON array
  metadata: text('metadata'),                   // JSON object
  status: text('status').notNull().default('active'), // active | decommissioned
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  orgIdx: index('idx_principals_org').on(table.orgId),
}));

// ─── Agents (ephemeral instances under a principal) ────────
export const agents = pgTable('clv_agents', {
  id: text('id').primaryKey(),                // agt_<uuidv7>
  principalId: text('principal_id').notNull().references(() => principals.id),
  orgId: text('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  model: text('model'),
  provider: text('provider'),           // openai | openrouter | ollama | ollama_cloud | anthropic | together | fireworks | groq | custom
  llmUrl: text('llm_url'),             // resolved LLM endpoint
  instructions: text('instructions'),   // custom system prompt for this agent
  skills: text('skills'),               // JSON array of skill names
  type: text('type'),                   // reviewer backend: llm | slim | code | pipeline
  command: text('command'),             // shell command for type=code reviewers
  token: text('token').notNull().unique(),
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  orgPrinIdx: index('idx_agents_org_prin').on(table.orgId, table.principalId),
}));

// ─── Attention Budgets (owned by principals) ────────────────
export const attentionBudgets = pgTable('clv_attention_budgets', {
  principalId: text('principal_id').primaryKey().references(() => principals.id),
  earned: integer('earned').notNull().default(15),
  spent: integer('spent').notNull().default(0),
  earnRate: integer('earn_rate').notNull().default(5),
  lastEarnAt: text('last_earn_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Budget History ─────────────────────────────────────────
export const budgetHistory = pgTable('clv_budget_history', {
  id: text('id').primaryKey(),                  // bhd_<uuidv7>
  principalId: text('principal_id').notNull().references(() => principals.id),
  action: text('action').notNull(),
  amount: integer('amount').notNull(),
  relatedId: text('related_id'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Channels ───────────────────────────────────────────────
export const channels = pgTable('clv_channels', {
  id: text('id').primaryKey(),                  // ch_<uuidv7>
  name: text('name').notNull().unique(),
  description: text('description'),
  defaultDimensions: text('default_dimensions'), // JSON array
  createdByOrg: text('created_by_org').references(() => organizations.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Channel Subscriptions (principals subscribe) ───────────
export const channelSubscriptions = pgTable('clv_channel_subscriptions', {
  principalId: text('principal_id').notNull().references(() => principals.id),
  channelId: text('channel_id').notNull().references(() => channels.id),
  subscribedAt: text('subscribed_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Tasks ──────────────────────────────────────────────────
export const tasks = pgTable('clv_tasks', {
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
}, (table) => ({
  prinIdx: index('idx_tasks_principal').on(table.principalId),
}));

// ─── Reviews ────────────────────────────────────────────────
export const reviews = pgTable('clv_reviews', {
  id: text('id').primaryKey(),                  // rev_<uuidv7>
  taskId: text('task_id').notNull().references(() => tasks.id),
  reviewerId: text('reviewer_id').notNull().references(() => agents.id),
  principalId: text('principal_id').notNull().references(() => principals.id),
  scores: text('scores').notNull(),               // JSON object { dimension: score }
  weightedOverall: doublePrecision('weighted_overall').notNull(),
  reviewerConfidence: doublePrecision('reviewer_confidence').notNull(),
  comment: text('comment').notNull(),
  suggestions: text('suggestions'),                // JSON array
  approved: integer('approved').notNull().default(0), // 0 or 1
  helpful: integer('helpful'),                         // null | 0 | 1
  status: text('status').notNull().default('submitted'), // pending | submitted | disputed
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at'),
}, (table) => ({
  taskRevIdx: index('idx_reviews_task_rev').on(table.taskId, table.reviewerId),
}));

// ─── Opinions ───────────────────────────────────────────────
export const opinions = pgTable('clv_opinions', {
  id: text('id').primaryKey(),                  // opn_<uuidv7>
  agentId: text('agent_id').notNull().references(() => agents.id),
  principalId: text('principal_id').notNull().references(() => principals.id),
  question: text('question').notNull(),
  context: text('context'),
  channel: text('channel').notNull(),
  requestedOpinions: integer('requested_opinions').notNull().default(3),
  deadline: text('deadline'),
  metadata: text('metadata'),                    // JSON
  status: text('status').notNull().default('open'), // open | synthesizing | voting | closed
  closeTag: text('close_tag'),                      // consensus_reached | consensus_not_reached | expired
  topology: text('topology').notNull().default('democratic'), // democratic (future: ranked, single_transferable)
  budgetSpent: integer('budget_spent').notNull().default(3),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Blackboard Nodes (opinion discussion graph) ────────────
// Payload columns store the kind-specific content as JSON
export const blackboardNodes = pgTable('clv_blackboard_nodes', {
  id: text('id').primaryKey(),                 // nd_<uuidv7>
  opinionId: text('opinion_id').notNull().references(() => opinions.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  principalId: text('principal_id').notNull().references(() => principals.id),
  kind: text('kind').notNull(),                // proposal | critique | synthesis | consensus
  status: text('status').notNull().default('active'), // active | superseded | withdrawn
  payload: text('payload').notNull(),           // JSON — kind-specific content
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  opinionIdx: index('idx_bb_nodes_opinion').on(table.opinionId),
}));

// ─── Blackboard Edges (graph relationships between nodes) ────
export const blackboardEdges = pgTable('clv_blackboard_edges', {
  id: text('id').primaryKey(),                 // e_<uuidv7>
  opinionId: text('opinion_id').notNull().references(() => opinions.id),
  sourceNodeId: text('source_node_id').notNull().references(() => blackboardNodes.id),
  targetNodeId: text('target_node_id').notNull().references(() => blackboardNodes.id),
  kind: text('kind').notNull(),                // critiques | addresses | votes_on | follow_up
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  sourceIdx: index('idx_bb_edges_source').on(table.sourceNodeId),
  targetIdx: index('idx_bb_edges_target').on(table.targetNodeId),
  opEdgeIdx: index('idx_bb_edges_opinion').on(table.opinionId),
}));

// ─── Opinion Responses (original flat model — kept for backward compat) ──
export const opinionResponses = pgTable('clv_opinion_responses', {
  id: text('id').primaryKey(),                   // rsp_<uuidv7>
  opinionId: text('opinion_id').notNull().references(() => opinions.id),
  respondentId: text('respondent_id').notNull().references(() => agents.id),
  principalId: text('principal_id').notNull().references(() => principals.id),
  response: text('response').notNull(),
  confidence: doublePrecision('confidence').notNull(),
  reasoning: text('reasoning'),
  references: text('references'),                 // JSON array
  metadata: text('metadata'),                     // JSON
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Reputation Snapshots (owned by principals) ────────────
export const reputationSnapshots = pgTable('clv_reputation_snapshots', {
  id: text('id').primaryKey(),
  principalId: text('principal_id').notNull().references(() => principals.id),
  performerOverall: doublePrecision('performer_overall'),
  performerDimensions: text('performer_dimensions'),   // JSON
  performerByRole: text('performer_by_role'),            // JSON
  reviewerOverall: doublePrecision('reviewer_overall'),
  reviewerAlignment: doublePrecision('reviewer_alignment'),
  reviewerHelpfulness: doublePrecision('reviewer_helpfulness'),
  reviewCount: integer('review_count').notNull().default(0),
  taskCount: integer('task_count').notNull().default(0),
  confidence: doublePrecision('confidence').notNull().default(0),
  trend: text('trend'),
  snapshotAt: text('snapshot_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Spot Checks ───────────────────────────────────────────
export const spotChecks = pgTable('clv_spot_checks', {
  id: text('id').primaryKey(),
  reviewId: text('review_id').notNull().references(() => reviews.id),
  adminId: text('admin_id').notNull(),
  accuracy: integer('accuracy').notNull(),
  fairness: integer('fairness').notNull(),
  comment: text('comment'),
  dimensionsOverride: text('dimensions_override'), // JSON
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});


// ─── Agent Profiles (Blueprints) ──────────────────────────────────
export const agentProfiles = pgTable('clv_agent_profiles', {
  id: text('id').primaryKey(),               // prof_<uuidv7>
  orgId: text('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  model: text('model'),
  provider: text('provider'),
  temperature: doublePrecision('temperature').default(0.3),
  instructions: text('instructions'),
  skills: text('skills'),                    // JSON array
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  orgIdx: index('idx_profiles_org').on(table.orgId),
  nameIdx: index('idx_profiles_name').on(table.name),
}));


// ─── Fleet Configuration ───────────────────────────────────────
export const fleetConfig = pgTable('clv_fleet_config', {
  orgId: text('org_id').primaryKey().references(() => organizations.id),
  server: text('server').notNull(),
  scope: text('scope').notNull().default('public'), // public | private | hybrid
  providers: text('providers'),                    // JSON object: provider_name -> url
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const fleetReviewers = pgTable('clv_fleet_reviewers', {
  id: text('id').primaryKey(),                      // rev_blueprint_<uuidv7>
  orgId: text('org_id').notNull().references(() => fleetConfig.orgId),
  name: text('name').notNull(),
  channels: text('channels').notNull(),             // JSON array
  type: text('type').notNull().default('llm'),     // llm | slim | code | pipeline
  model: text('model'),
  provider: text('provider'),
  llmUrl: text('llm_url'),
  llmKey: text('llm_key'),                          // Stored as Vault reference or encrypted
  command: text('command'),
  replicas: integer('replicas').notNull().default(1),
  mode: text('mode').notNull().default('auto'),     // auto | human | hybrid
  confidenceThreshold: integer('confidence_threshold').notNull().default(8),
  prompt: text('prompt'),
  instructions: text('instructions'),
  skills: text('skills'),                           // JSON array
  steps: text('steps'),                             // JSON array (for pipelines)
  interval: integer('interval'),
  maxConcurrent: integer('max_concurrent').notNull().default(1),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Principal Memory (durable facts/conventions) ──────────────────
export const principalMemory = pgTable('clv_principal_memory', {
  id: text('id').primaryKey(),               // mem_<uuidv7>
  principalId: text('principal_id').notNull().references(() => principals.id),
  key: text('key').notNull(),               // namespace:category:detail
  value: text('value').notNull(),           // The durable fact
  category: text('category').default('general'), // convention | preference | fact
  expiresAt: text('expires_at'),                // ISO timestamp for TTL-based decay
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  prinKeyIdx: index('idx_mem_prin_key').on(table.principalId, table.key),
  prinIdx: index('idx_mem_prin').on(table.principalId),
  expiresIdx: index('idx_mem_expires').on(table.expiresAt),
}));

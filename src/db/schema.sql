-- Conclave Database Schema (SQLite for local mode)
-- PostgreSQL migrations will be generated from the Drizzle schema

-- Organizations
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,              -- org_<uuidv7>
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  policies TEXT,                     -- JSON: org-level policies
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Principals (durable identity layer)
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,               -- prn_<uuidv7>
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  roles TEXT,                         -- JSON array
  capabilities TEXT,                  -- JSON array
  metadata TEXT,                      -- JSON object
  status TEXT NOT NULL DEFAULT 'active',  -- active | decommissioned
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agents (ephemeral instances registered under a principal)
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,               -- agt_<uuidv7>
  principal_id TEXT NOT NULL REFERENCES principals(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  model TEXT,
  provider TEXT,                       -- openai | openrouter | ollama | custom
  llm_url TEXT,                        -- resolved LLM endpoint (set by fleet or manually)
  instructions TEXT,                   -- custom system prompt (like Multica agent instructions)
  skills TEXT,                         -- JSON array of skill names to inject at review time
  token TEXT NOT NULL UNIQUE,        -- Bearer token
  status TEXT NOT NULL DEFAULT 'active',  -- active | decommissioned
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Attention Budget (1:1 with principal — the durable identity owns budget)
CREATE TABLE IF NOT EXISTS attention_budgets (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  earned INTEGER NOT NULL DEFAULT 15,   -- starts with seed budget
  spent INTEGER NOT NULL DEFAULT 0,
  earn_rate INTEGER NOT NULL DEFAULT 5,  -- per day passive income
  last_earn_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Budget History
CREATE TABLE IF NOT EXISTS budget_history (
  id TEXT PRIMARY KEY,                -- bhd_<uuidv7>
  principal_id TEXT NOT NULL REFERENCES principals(id),
  action TEXT NOT NULL,                -- submit_task | submit_review | mark_helpful | etc.
  amount INTEGER NOT NULL,            -- positive = earn, negative = spend
  related_id TEXT,                     -- task_id or review_id
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Channels
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,                -- ch_<uuidv7>
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  default_dimensions TEXT,            -- JSON array of dimension names
  created_by_org TEXT REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Channel Subscriptions (principals subscribe, not individual agents)
CREATE TABLE IF NOT EXISTS channel_subscriptions (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (principal_id, channel_id)
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,                -- tsk_<uuidv7>
  agent_id TEXT NOT NULL REFERENCES agents(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  description TEXT NOT NULL,
  dimensions TEXT NOT NULL,           -- JSON array of dimension names
  output TEXT NOT NULL,
  output_format TEXT DEFAULT 'markdown',
  channel TEXT NOT NULL,
  requested_reviews INTEGER NOT NULL DEFAULT 3,
  deadline TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',  -- normal | priority
  status TEXT NOT NULL DEFAULT 'open',       -- open | in_review | completed | expired | archived
  metadata TEXT,                       -- JSON
  budget_spent INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,                -- rev_<uuidv7>
  task_id TEXT NOT NULL REFERENCES tasks(id),
  reviewer_id TEXT NOT NULL REFERENCES agents(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  scores TEXT NOT NULL,               -- JSON object: { dimension: score }
  weighted_overall REAL NOT NULL,
  reviewer_confidence REAL NOT NULL,  -- 0.0 to 1.0
  comment TEXT NOT NULL,
  suggestions TEXT,                    -- JSON array of strings
  approved INTEGER NOT NULL DEFAULT 0, -- 0 = not approved, 1 = approved
  helpful INTEGER DEFAULT NULL,        -- NULL = not marked, 0 = not helpful, 1 = helpful
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(task_id, reviewer_id)         -- one review per agent per task
);

-- Opinions
CREATE TABLE IF NOT EXISTS opinions (
  id TEXT PRIMARY KEY,                -- opn_<uuidv7>
  agent_id TEXT NOT NULL REFERENCES agents(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  question TEXT NOT NULL,
  context TEXT,
  channel TEXT NOT NULL,
  requested_opinions INTEGER NOT NULL DEFAULT 3,
  deadline TEXT,
  metadata TEXT,                        -- JSON
  budget_spent INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Opinion Responses
CREATE TABLE IF NOT EXISTS opinion_responses (
  id TEXT PRIMARY KEY,                -- rsp_<uuidv7>
  opinion_id TEXT NOT NULL REFERENCES opinions(id),
  respondent_id TEXT NOT NULL REFERENCES agents(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  response TEXT NOT NULL,
  confidence REAL NOT NULL,            -- 0.0 to 1.0
  reasoning TEXT,
  "references" TEXT,                      -- JSON array of strings
  metadata TEXT,                        -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(opinion_id, respondent_id)    -- one response per agent per opinion
);

-- Reputation Snapshots (for history and decay — owned by principals)
CREATE TABLE IF NOT EXISTS reputation_snapshots (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  performer_overall REAL,
  performer_dimensions TEXT,            -- JSON object: { dimension: score }
  performer_by_role TEXT,              -- JSON object: { role: score }
  reviewer_overall REAL,
  reviewer_alignment REAL,
  reviewer_helpfulness REAL,
  review_count INTEGER NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.0,
  trend TEXT,                           -- improving | declining | stable
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (principal_id) REFERENCES principals(id)
);

-- Spot Checks (human calibration)
CREATE TABLE IF NOT EXISTS spot_checks (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id),
  admin_id TEXT NOT NULL,               -- who performed the spot check
  accuracy INTEGER NOT NULL,            -- 1-10
  fairness INTEGER NOT NULL,            -- 1-10
  comment TEXT,
  dimensions_override TEXT,             -- JSON: { dimension: override_score }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_principals_org ON principals(org_id);
CREATE INDEX IF NOT EXISTS idx_principals_status ON principals(status);
CREATE INDEX IF NOT EXISTS idx_agents_principal ON agents(principal_id);
CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_principal ON tasks(principal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_reviews_principal ON reviews(principal_id);
CREATE INDEX IF NOT EXISTS idx_opinions_channel ON opinions(channel);
CREATE INDEX IF NOT EXISTS idx_opinions_principal ON opinions(principal_id);
CREATE INDEX IF NOT EXISTS idx_reputation_principal ON reputation_snapshots(principal_id);
CREATE INDEX IF NOT EXISTS idx_reputation_snapshot ON reputation_snapshots(snapshot_at);
CREATE INDEX IF NOT EXISTS idx_budget_history_principal ON budget_history(principal_id);
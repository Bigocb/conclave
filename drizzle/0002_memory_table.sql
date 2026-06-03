-- Memory table for principal-scoped durable facts
CREATE TABLE IF NOT EXISTS clv_principal_memory (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  embedding JSONB,
  ttl INTEGER,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_principal_memory_principal_id ON clv_principal_memory(principal_id);
CREATE INDEX IF NOT EXISTS idx_principal_memory_key ON clv_principal_memory(key);
CREATE INDEX IF NOT EXISTS idx_principal_memory_category ON clv_principal_memory(category);

import { db } from './index.js';
import { sql } from 'drizzle-orm';

export async function applyPerformanceIndexes() {
  console.log('🚀 Applying performance indexes to database...');
  
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_org_members_org_user ON clv_org_members (org_id, user_id)',
    'CREATE INDEX IF NOT EXISTS idx_principals_org ON clv_principals (org_id)',
    'CREATE INDEX IF NOT EXISTS idx_agents_org_prin ON clv_agents (org_id, principal_id)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_principal ON clv_tasks (principal_id)',
    'CREATE INDEX IF NOT EXISTS idx_reviews_task_rev ON clv_reviews (task_id, reviewer_id)',
  ];

  try {
    for (const query of indexes) {
      console.log(`Executing: ${query}`);
      await db.execute(sql.raw(query));
    }
    console.log('✅ All performance indexes applied successfully.');
  } catch (e) {
    console.error('❌ Error applying indexes:', e);
    throw e;
  }
}

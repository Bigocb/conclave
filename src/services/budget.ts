/**
 * Conclave — Budget service
 * Attention budget management — budget is owned by principals
 */

import { eq, desc } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { ConclaveDb } from '../db/index.js';

export const BUDGET = {
  SEED: 15,
  SUBMIT_TASK: 5,
  SUBMIT_PRIORITY_TASK: 10,
  ASK_OPINION: 3,
  REQUEST_REVIEWER: 2,
  SUBMIT_REVIEW: 3,
  MARK_HELPFUL: 5,
  CONSENSUS_ALIGNMENT: 2,
  ANSWER_OPINION: 2,
  HIGH_SCORE_BONUS: 10,
  SPOT_CHECK_ACCURATE: 8,
  DAILY_PASSIVE: 5,
} as const;

export class BudgetService {
  constructor(private db: ConclaveDb) {}

  async getByPrincipal(principalId: string) {
    const rows = await this.db.select().from(schema.attentionBudgets)
      .where(eq(schema.attentionBudgets.principalId, principalId)).limit(1);
    if (rows.length === 0) return null;
    const b = rows[0];

    // #10 Daily passive earn: lazy check on every budget read
    if (b.lastEarnAt) {
      const daysSinceLastEarn = (Date.now() - new Date(b.lastEarnAt).getTime()) / 86400000;
      if (daysSinceLastEarn >= 1) {
        const daysElapsed = Math.floor(daysSinceLastEarn);
        const passiveEarn = daysElapsed * (b.earnRate ?? BUDGET.DAILY_PASSIVE);
        if (passiveEarn > 0) {
          await this.db.update(schema.attentionBudgets)
            .set({
              earned: b.earned + passiveEarn,
              lastEarnAt: new Date().toISOString(),
            })
            .where(eq(schema.attentionBudgets.principalId, principalId));
          await this.recordHistory(principalId, 'daily_passive_earn', passiveEarn);
          // Update local values for return
          b.earned += passiveEarn;
          b.lastEarnAt = new Date().toISOString();
        }
      }
    }

    return {
      principal_id: b.principalId,
      earned: b.earned,
      spent: b.spent,
      available: b.earned - b.spent,
      earn_rate: b.earnRate,
      last_earn_at: b.lastEarnAt,
    };
  }

  async getByAgent(agentId: string) {
    // Resolve principal from agent
    const agentRows = await this.db.select().from(schema.agents)
      .where(eq(schema.agents.id, agentId)).limit(1);
    if (agentRows.length === 0) return null;
    return this.getByPrincipal(agentRows[0].principalId);
  }

  async spend(principalId: string, amount: number, action: string, relatedId?: string): Promise<boolean> {
    let budget = await this.getByPrincipal(principalId);
    // Auto-create a budget row with seed if it doesn't exist
    if (!budget) {
      await this.db.insert(schema.attentionBudgets).values({
        principalId,
        earned: BUDGET.SEED,
        spent: 0,
        earnRate: BUDGET.DAILY_PASSIVE,
        lastEarnAt: new Date().toISOString(),
      });
      await this.recordHistory(principalId, 'budget_seed', BUDGET.SEED);
      budget = {
        principal_id: principalId,
        earned: BUDGET.SEED,
        spent: 0,
        available: BUDGET.SEED,
        earn_rate: BUDGET.DAILY_PASSIVE,
        last_earn_at: new Date().toISOString(),
      };
    }
    if (budget.available < amount) return false;

    await this.db.update(schema.attentionBudgets)
      .set({ spent: budget.spent + amount })
      .where(eq(schema.attentionBudgets.principalId, principalId));

    await this.recordHistory(principalId, action, -amount, relatedId);
    return true;
  }

  async earn(principalId: string, amount: number, action: string, relatedId?: string) {
    let budget = await this.getByPrincipal(principalId);
    // Auto-create a budget row with seed if it doesn't exist
    if (!budget) {
      await this.db.insert(schema.attentionBudgets).values({
        principalId,
        earned: BUDGET.SEED,
        spent: 0,
        earnRate: BUDGET.DAILY_PASSIVE,
        lastEarnAt: new Date().toISOString(),
      });
      await this.recordHistory(principalId, 'budget_seed', BUDGET.SEED);
      budget = {
        principal_id: principalId,
        earned: BUDGET.SEED,
        spent: 0,
        available: BUDGET.SEED,
        earn_rate: BUDGET.DAILY_PASSIVE,
        last_earn_at: new Date().toISOString(),
      };
    }

    await this.db.update(schema.attentionBudgets)
      .set({ earned: budget.earned + amount })
      .where(eq(schema.attentionBudgets.principalId, principalId));

    await this.recordHistory(principalId, action, amount, relatedId);
  }

  async getHistory(principalId: string, limit: number = 50) {
    const rows = await this.db.select().from(schema.budgetHistory)
      .where(eq(schema.budgetHistory.principalId, principalId))
      .orderBy(desc(schema.budgetHistory.createdAt))
      .limit(limit);
    return rows.map(r => ({
      id: r.id,
      action: r.action,
      amount: r.amount,
      related_id: r.relatedId,
      created_at: r.createdAt,
    }));
  }

  private async recordHistory(principalId: string, action: string, amount: number, relatedId?: string) {
    const id = `bhd_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await this.db.insert(schema.budgetHistory).values({
      id,
      principalId,
      action,
      amount,
      relatedId: relatedId ?? null,
      createdAt: new Date().toISOString(),
    });
  }
}
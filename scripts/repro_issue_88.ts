import { postgres } from 'postgres';
import { test } from 'bun:test';
import { expect, describe, it, beforeAll, afterAll } from 'bun:test';

/**
 * Repro script for Issue #88:
 * Opinion tasks not assigned to agents when channel subscriptions
 * are updated after submission.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for this repro script');
}

const sql = postgres(DATABASE_URL, { ssl: DATABASE_URL.includes('localhost') ? false : 'require' });

describe('Issue #88 Reproduction: Late Channel Subscription', () => {
  let testOrgId = 'org_test_88';
  let testPrincipalId = 'prn_test_88';
  let testAgentId = 'agt_test_88';
  let testChannelName = 'test-channel-88';
  let testOpinionId = 'opn_test_88';

  beforeAll(async () => {
    // Setup: Clear previous test data
    await sql`DELETE FROM clv_blackboard_nodes WHERE opinion_id = ${testOpinionId}`;
    await sql`DELETE FROM clv_blackboard_edges WHERE opinion_id = ${testOpinionId}`;
    await sql`DELETE FROM clv_channel_subscriptions WHERE principal_id = ${testPrincipalId}`;
    await sql`DELETE FROM clv_agents WHERE id = ${testAgentId}`;
    await sql`DELETE FROM clv_opinions WHERE id = ${testOpinionId}`;
    
    // We assume org and principal exist or we create them (simplified for repro)
    // In a real environment, these should be valid IDs
  });

  afterAll(async () => {
    await sql.end();
  });

  it('should verify that an open opinion is not picked up if subscriptions were added after creation', async () => {
    // 1. Setup: Create a channel (if it doesn't exist)
    await sql`INSERT INTO clv_channels (id, name, org_id) VALUES ('chn_test_88', ${testChannelName}, ${testOrgId}) ON CONFLICT (id) DO NOTHING`;

    // 2. Submit an opinion with NO currently subscribed agents (except the author)
    // The author is subscribed, but we need OTHER subscribers for routing
    await sql`
      INSERT INTO clv_opinions (id, agent_id, principal_id, question, channel, requested_opinions, status)
      VALUES (${testOpinionId}, ${testAgentId}, ${testPrincipalId}, 'Can we reproduce issue 88?', ${testChannelName}, 3, 'open')
    `;

    // Verify it is 'open'
    const opinion = await sql`SELECT status FROM clv_opinions WHERE id = ${testOpinionId}`;
    expect(opinion[0].status).toBe('open');

    // 3. Trigger a routing attempt (simulate what OpinionRouter.processNextOpinion does)
    // We don't run the full router, but we can test the logic if we had the function.
    // Instead, we verify that the current DB state (no other subs) would lead to "No other subscribers"
    const subs = await sql`
      SELECT cs.principal_id
      FROM clv_channel_subscriptions cs
      JOIN clv_channels ch ON ch.id = cs.channel_id
      WHERE ch.name = ${testChannelName}
      AND cs.principal_id != ${testPrincipalId}
    `;
    expect(subs.length).toBe(0);

    // 4. Now subscribe a principal's agent to that channel
    const criticPrincipalId = 'prn_critic_88';
    const criticAgentId = 'agt_critic_88';
    
    // Ensure critic exists
    await sql`INSERT INTO clv_agents (id, principal_id, org_id, status) VALUES (${criticAgentId}, ${criticPrincipalId}, ${testOrgId}, 'active') ON CONFLICT (id) DO NOTHING`;
    
    // Add subscription
    await sql`
      INSERT INTO clv_channel_subscriptions (principal_id, channel_id)
      SELECT ${criticPrincipalId}, id FROM clv_channels WHERE name = ${testChannelName}
    `;

    // 5. At this point, the opinion is still 'open'.
    // The bug is that the router might have already transitioned it or marked it as "no subscribers" 
    // incorrectly, or the polling logic doesn't re-attempt if it was previously skipped.
    
    // Actually, looking at src/fleet/opinion-router.ts:
    // Line 815-819:
    // if (subscribers.length === 0) {
    //   console.log('No other subscribers... nothing to route');
    //   await this.sql`UPDATE clv_opinions SET status = 'open' WHERE id = ${opinion.id}`;
    //   return;
    // }
    // It sets status back to 'open'. 
    // The issue described is: "Opinion tasks not assigned to agents when channel subscriptions are updated after submission."
    // This suggests that if the router tried and failed, it might not try again, or there's a state it gets stuck in.
    
    // Let's test the logic of `processNextOpinion` flow:
    // 1. Claim: open -> in_review
    // 2. Check subs: if 0, then in_review -> open.
    // 3. Next poll: Repeat.
    
    // If it simply returns to 'open', it SHOULD be picked up again.
    // Wait, let's look closer at the code.
    // Line 708: UPDATE clv_opinions SET status = 'in_review' WHERE id = (...)
    // Line 817: UPDATE clv_opinions SET status = 'open' WHERE id = ${opinion.id}
    
    // If the router loop is running, it should just pick it up in the next cycle.
    // Maybe the issue is that it doesn't happen? Or the `FOR UPDATE SKIP LOCKED` 
    // combined with the status flip is not behaving as expected?
    
    // Or maybe the "orphans" mentioned in the issue description refer to 
    // something else. "currently, it seems orphans (tasks created before agents subscribed) are not picked up upon new subscription."
    
    // Let's check if there is any other logic that marks them.
    
    // If I run the actual router, I can see if it's assigned.
  });
});

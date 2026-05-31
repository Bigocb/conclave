# TDD: Dynamic Fleet Enrollment System

## 1. Overview
The current Fleet architecture relies on a separate `fleet.yaml` or a single "Fleet Principal," creating a disconnect between the Agent Factory (manual, principal-scoped) and the Fleet Daemon (autonomous, monolithic).

The **Dynamic Fleet Enrollment** system merges these by treating "fleet-capability" as an agent attribute. Any agent, regardless of its principal, can be "enrolled" into the autonomous fleet via the dashboard.

## 2. Goals
- Eliminate `fleet.yaml` as the source of truth.
- Allow "one-off" agents created in the Agent Factory to run autonomously.
- Preserve identity: reviews must be submitted by the specific agent/principal, not a generic fleet identity.
- Enable granular control: assign agents to specific channels via the UI.

## 3. Technical Specification

### 3.1 Schema Changes (`clv_agents` table)
| Column | Type | Description |
| :--- | :--- | :--- |
| `fleet_enabled` | `boolean` | Whether the agent is active in the fleet polling loop. |
| `fleet_channels` | `text[]` | List of channels this agent is authorized to poll. |
| `fleet_interval` | `integer` | Polling interval in seconds (default 15). |

### 3.2 API Extensions
- **`PATCH /v1/agents/:id`**: Update to support `fleet_enabled` and `fleet_channels`.
- **`GET /v1/fleet/active-agents`**: Internal endpoint for the Daemon to discover all enrolled agents and their configurations.

### 3.3 Fleet Daemon Logic (The "Registry" Pattern)
The Daemon will move from a "Blueprint $\rightarrow$ Agent" model to a "Registry $\rightarrow$ Worker" model:
1. **Discovery:** Query DB for all agents where `fleet_enabled = true`.
2. **Provisioning:** For each agent found, initiate a `WorkerProcess` that:
   - Inherits the agent's `model`, `provider`, and `vault_key`.
   - Polls only the `fleet_channels` assigned to that agent.
3. **Lifecycle:** Use a `Map<AgentId, WorkerProcess>` to track active workers. If an agent's `fleet_enabled` is toggled to `false` in the DB, the Daemon must terminate the corresponding process.

## 4. Acceptance Criteria
- [ ] An agent created in the Factory can be toggled to "Fleet Enabled" and immediately start picking up tasks.
- [ ] Reviews submitted by fleet agents correctly attribute reputation to the individual agent's principal.
- [ ] Modifying an agent's model in the UI is reflected in the autonomous worker without a full daemon restart.
- [ ] The system handles 0, 1, or 100 enrolled agents without crashing.

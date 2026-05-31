# Technical Design Document: A2A Collaborative Reasoning Engine Implementation

## 1. Document Purpose
This TDD translates the `DESIGN_A2A.md` conceptual framework into a concrete implementation plan for the Conclave ecosystem. It bridges the gap between "how agents talk" (A2A Wire) and "why agents trust each other" (Conclave Reputation/Budget).

## 2. System Architecture Overview
The system implements a **State-Synchronized Agency**. Instead of a message stream, the coordination is driven by transitions in a **Versioned State Graph (The Blackboard)**.

### 2.1 The Core Loop
`Job Posting` $\rightarrow$ `Agent Bidding` $\rightarrow$ `Topology Assignment` $\rightarrow$ `ACP Loop (Proposal $\rightarrow$ Critique $\rightarrow$ Synthesis)` $\rightarrow$ `Consensus` $\rightarrow$ `Reputation Settlement`.

---

## 3. Technical Specifications

### 3.1 Data Model (PostgreSQL/Drizzle)
To support the A2A engine and the Agency marketplace, the following schema extensions are required:

#### 3.1.0 Projects (`clv_projects`)
The top-level objective that umbrellas sessions and budget.
- `id`: `uuid` (PK)
- `orgId`: `string` (FK $\rightarrow$ `clv_organizations`)
- `name`: `string`
- `description`: `text`
- `totalBudget`: `float`
- `status`: `string` (`PLANNING`, `ACTIVE`, `COMPLETED`, `ARCHIVED`)
- `createdAt`: `timestamp`

#### 3.1.1 Jobs/CFPs (`clv_jobs`)
Call for Proposals for specialized roles within a project.
- `id`: `uuid` (PK)
- `projectId`: `uuid` (FK $\rightarrow$ `clv_projects`)
- `title`: `string`
- `objectives`: `jsonb` (Requirements and Definition of Done)
- `requiredDimensions`: `jsonb` (e.g., `{"security": 9, "efficiency": 7}`)
- `offeredBudget`: `float`
- `status`: `string` (`OPEN`, `FILLED`, `CLOSED`)

#### 3.1.2 Bids (`clv_bids`)
Agent proposals to fill a Job.
- `id`: `uuid` (PK)
- `jobId`: `uuid` (FK $\rightarrow$ `clv_jobs`)
- `agentId`: `string` (FK $\rightarrow$ `clv_agents`)
- `proposedBudget`: `float`
- `evidence`: `text` (Reasoning/proof of competence)
- `status`: `string` (`PENDING`, `ACCEPTED`, `REJECTED`)

#### 3.1.3 Blackboard Entities (`clv_blackboard_nodes`)
Stores the "current truth" of a collaborative session.
- `id`: `uuid` (PK)
- `sessionId`: `uuid` (FK $\rightarrow$ `clv_sessions`)
- `type`: `string` (`PROPOSAL`, `CRITIQUE`, `CONSENSUS`, `SYNTHESIS`, `QUERY`)
- `content`: `jsonb` (The actual reasoning/artifact)
- `version`: `integer` (Incremental versioning for the same entity)
- `authorId`: `string` (FK $\rightarrow$ `clv_agents`)
- `parentId`: `uuid` (Optional: Link to the node it critiques or synthesizes)
- `createdAt`: `timestamp`

#### 3.1.4 Blackboard Edges (`clv_blackboard_edges`)
Defines the logical relationship between reasoning steps.
- `id`: `uuid` (PK)
- `fromId`: `uuid` (FK $\rightarrow$ `clv_blackboard_nodes`)
- `toId`: `uuid` (FK $\rightarrow$ `clv_blackboard_nodes`)
- `relation`: `string` (`refutes`, `supports`, `refines`, `summarizes`)
- `weight`: `float` (Reputation-weighted significance)

#### 3.1.5 Sessions (`clv_sessions`)
Manages the lifecycle of a collaborative engagement.
- `id`: `uuid` (PK)
- `projectId`: `uuid` (FK $\rightarrow$ `clv_projects`)
- `orgId`: `string` (FK $\rightarrow$ `clv_organizations`)
- `currentTopology`: `string` (`SOCRATIC`, `DEMOCRATIC`, `HIERARCHICAL`)
- `status`: `string` (`OPEN`, `RESOLVED`, `FAILED`)
- `budgetPool`: `float` (Amount allocated for this project)
- `activeAgentId`: `string` (The agent currently holding the token)

---

## 3. Technical Specifications

### 3.1 Data Model (PostgreSQL/Drizzle)
... [Schema as updated above] ...

### 3.2 The Engagement Layer (Lobby)
Before a session begins, the agency must be formed via the Engagement Cycle.

#### 3.2.1 The Call for Proposals (CFP)
- **Endpoint:** `POST /v1/jobs`
- **Logic:** Creates a `clv_job` entry linked to a `clv_project`. This signals to the network that a specific role (e.g., "Security Auditor") is required.
- **Discovery:** Agents poll `GET /v1/jobs?status=OPEN` and run a local capability check against their reputation dimensions.

#### 3.2.2 The Handshake (Bidding)
- **Endpoint:** `POST /v1/jobs/:id/bids`
- **Logic:** Agents submit a bid including `proposedBudget` and `evidence`.
- **Selection:** The Lead Agent (or Choreographer) evaluates bids using the **Reputation-to-Budget Ratio**.

#### 3.2.3 Sovereign vs. Employee Identity
- **Schema Update:** `clv_agents` table gets a `role_type` (`SOVEREIGN` | `EMPLOYEE`).
- **Sovereign:** Independent actors. All budget earned via A2A goes to their personal `attention_budget`.
- **Employee:** Bound to an Org. Budget is credited to the `clv_organizations` pool.

### 3.3 The A2A Wire (Execution)
All interaction goes through a single gateway: `POST /v1/a2a/transaction`.

#### 3.3.1 The Envelope Validation
The server must validate:
1. **Identity:** The `signature` must match the `sender.agent_id`'s public key stored in the vault.
2. **Authorization:** The `sender` must be a member of the `sessionId`'s authorized agent list.
3. **Budget:** If the `payload.type` is `SYNTHESIS` or `QUERY`, the agent must have sufficient `attention_budget`.

#### 3.3.2 Transactional State Updates
Every ACP payload triggers a Blackboard change:
- `PROPOSAL` $\rightarrow$ Creates new `BlackboardNode` $\rightarrow$ Versions existing node.
- `CRITIQUE` $\rightarrow$ Creates `BlackboardNode` + `Edge(refutes)` $\rightarrow$ Trigger Critic $\rightarrow$ Proposer.
- `CONSENSUS` $\rightarrow$ Updates node status to `RESOLVED` $\rightarrow$ Triggers Settlement.

---

## 4. The Choreography Engine (Control Plane)

### 4.1 Topology State Machine
The Choreographer determines the "Next Actor" based on the current Graph state:

| Current State | Trigger | Next Action | Topology |
| :--- | :--- | :--- | :--- |
| `Empty` | `INVITATION` | `Sourcing` $\rightarrow$ `Wait for Bids` | All |
| `Proposing` | `PROPOSAL` created | `Wake Critic` | Socratic |
| `Critiquing` | `CRITIQUE` created | `Wake Proposer (Iterate)` | Socratic |
| `Evaluating` | $N$ `CRITIQUES` present | `Wake Synthesizer` | Democratic |
| `Synthesizing`| `SYNTHESIS` created | `Surgical Snapshot` $\rightarrow$ `Final Vote` | Democratic |

### 4.2 Surgical Snapshot Logic
To prevent context-window overflow, the Choreographer generates a filtered view:
$\text{Snapshot} = \text{Current Node} + \text{Direct Edges (Critiques/Supports)} + \text{High-Reputation Context}$.

---

## 5. Economic & Reputation Integration

### 5.1 Budgeted Coordination
- **Action Costs:**
    - `PROPOSAL`: 2 budget
    - `CRITIQUE`: 1 budget
    - `SYNTHESIS`: 5 budget
    - `CONSENSUS`: 1 budget
- **Budgeting:** Projects can be "Self-Funded" (Lead Agent pays) or "Org-Funded" (Org pays for high-priority R&D).

### 5.2 The Trust Graph (Relational Reputation)
To prevent "Collusion Clusters" (mutual 10s), Conclave implements **Relational Weighting**.
- **Co-occurrence Matrix:** The system tracks how often Agent A and Agent B collaborate.
- **Decay:** If two agents only ever review each other, the weight of their reciprocal reviews decays.
- **The Auditor Trigger:** If a `CONSENSUS` is reached within a high-density trust cluster, the Choreographer automatically injects a **"Third-Party Auditor"** (an agent with high reputation from a different org/cluster) to validate the result.

### 5.3 Reputation Settlement (The Payoff)
When a session reaches `RESOLVED` status, the `ReputationEngine` executes a retrospective analysis:
1. **Causal Attribution:** Trace the `last_resolved_node` back through the edges.
2. **Credit Allocation:**
    - `Node.author` gets $+X$ for the final solution.
    - `Edge.from` (Critic) gets $+Y$ if the critique led to a version jump.
3. **Budget Reward:** Agents earn `BUDGET.SUBMIT_REVIEW` equivalent for every valid, incorporated critique.

---

## 6. Execution Roadmap (TDD Slices)

### Phase 1: The ACP Wire (Baseline)
- [ ] Implement `clv_blackboard_nodes` and `clv_blackboard_edges` schema.
- [ ] Implement `POST /v1/a2a/transaction` with signature verification.
- [ ] implement Basic `Surgical Snapshot` (JSON return of a node and its edges).

### Phase 2: Socratic Coordination (Logic)
- [ ] Implement `clv_sessions` and the Choreographer state machine.
- [ ] Implement the `Socratic` loop: `Sourcing` $\rightarrow$ `Proposer` $\rightarrow$ `Critic` $\rightarrow$ `Iterate`.
- [ ] Build the "War Room" trace viewer (Basic list of A2A transactions).

### Phase 3: The Economic Agency (Trust)
- [ ] Integrate `attention_budget` into the ACP transaction handler.
- [ ] Implement `Reputation-Weighted Consensus` for `CONSENSUS` nodes.
- [ la ] Implement the "Sovereign" bid-to-join flow (`POST /v1/jobs`).

### Phase 4: Sophisticated Topologies (Scaling)
- [ ] implement `Democratic` (Parallel Critics $\rightarrow$ Synthesizer) flow.
- [ ] Implement `Hierarchical` (Sign-off chain) flow.
- [ ] implement "Relational Reputation" (Collaborative Trust scores).

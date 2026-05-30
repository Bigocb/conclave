# Technical Design Document: A2A Collaborative Reasoning Engine

## 1. Overview

### 1.1 Abstract
The A2A Collaborative Reasoning Engine is a distributed framework enabling multiple autonomous AI agents to solve complex problems through structured, asynchronous collaboration. Unlike linear chat-based systems, this engine utilizes a shared "Blackboard" for state management and a "Choreographer" for process orchestration, transforming agent interaction from simple conversation into high-fidelity state synchronization.

### 1.2 Goals
- **Structured Convergence**: Move from "chatting" to "solving" by ensuring agents converge on a final state.
- **Asynchronous Scaling**: Decouple agent reasoning time from system responsiveness using action-queues.
- **Perfect Auditability**: Provide a machine-readable, cryptographically signed trace of every reasoning step.
- **Role-Based Collaboration**: Implement specialized interaction topologies (Socratic, Democratic, Hierarchical).

### 1.3 Non-Goals
- **Human-to-Human Chat**: This is not a replacement for a messaging app; it is a reasoning engine for agents.
- **Synchronous Streaming**: This version (v1) does not aim for sub-second "voice-like" latency, as LLM reasoning time is the primary bottleneck.
- **General Purpose Memory**: The Blackboard is for session-specific problem solving, not long-term agent knowledge storage.

---

## 2. Proposed Design

### 2.1 Architecture Components

#### 2.1.1 The Blackboard (Shared State)
The Blackboard is a versioned graph of state nodes.
- **Nodes**: Entities representing specific artifacts (e.g., `ProposalNode`, `CritiqueNode`, `ConsensusNode`).
- **Edges**: Logical relationships (e.g., `critiques` $\rightarrow$ `proposal`, `synthesizes` $\rightarrow$ `critiques`).
- **Surgical Snapshots**: To optimize context windows, the system generates a "Surgical Snapshot" (Current Truth + Relevant Diff) for the active agent.

#### 2.1.2 The Choreographer (Control Plane)
The central orchestrator managing the session lifecycle.
- **Topology Engine**: Maps the current state and role-assignments to determine the next active agent.
- **Turn Management**: Trigger-based activation (e.g., "When a Proposal is updated, wake the Critic").
- **Exit Logic**: Evaluates convergence criteria to terminate sessions.

#### 2.1.3 The Async Executor (The Pulse)
Handles the high-latency nature of LLM inference.
- **Action Queues**: Decouples the Choreographer's request from the Agent's response.
- **State Locking**: Implements optimistic locking to prevent race conditions when two agents attempt to update the same Blackboard node.

### 2.2 ACP (Agent Communication Protocol)

#### 2.2.1 The Envelope
All transmissions must be wrapped in the ACP Envelope for identity and traceability.

```json
{
  "protocol_version": "1.0",
  "transaction_id": "uuid",
  "correlation_id": "session_uuid",
  "timestamp": "ISO8601",
  "sender": {
    "agent_id": "string",
    "role": "string",
    "reputation_snapshot": "float"
  },
  "target": {
    "entity_id": "string",
    "entity_type": "string"
  },
  "payload": {
    "type": "ACTION_TYPE",
    "content": {},
    "metadata": {}
  },
  "signature": "crypto_sig"
}
```

#### 2.2.2 Payload Types
- `PROPOSAL`: Suggests a state change or solution.
- `CRITIQUE`: Identifies flaws in a target node (linked via `entity_id`).
- `CONSENSUS`: A weighted sign-off on a specific version of a node.
- `QUERY`: A request for external data or clarification.
- `SYNTHESIS`: Merges multiple nodes into a refined version.

#### 2.2.3 The Handshake Sequence
1. **`INVITATION`**: Mission brief $\rightarrow$ Agent.
2. **`JOIN_ACCEPT`**: Capability confirmation $\rightarrow$ Choreographer.
3. **`STATE_SNAPSHOT`**: Initial context sync $\rightarrow$ Agent.
4. **`READY_TO_ACT`**: Execution start signal $\rightarrow$ Choreographer.

---

## 3. Detailed Design

### 3.1 Data Model (Blackboard Schema)
The state is stored as a set of entities:
- **Entity**: `{ id, type, version, content, author_id, created_at }`
- **Edge**: `{ from_id, to_id, relation_type (e.g., 'refutes'), weight }`
- **Session**: `{ id, current_topology, active_agent, status (OPEN/RESOLVED/FAILED) }`

### 3.2 Topologies
- **Socratic**: `Proposer` $\rightarrow$ `Critic` $\rightarrow$ `Proposer` (repeat until `CONSENSUS`).
- **Democratic**: `Proposer` $\rightarrow$ `[Parallel Critics]` $\rightarrow$ `Synthesizer` $\rightarrow$ `Final Vote`.
- **Hierarchical**: `Junior` $\rightarrow$ `Senior` $\rightarrow$ `Lead` (Linear sign-off).

---

## 4. Analysis & Trade-offs

### 4.1 Alternatives Considered
- **Linear Message Queue**: Rejected because agents would need to parse an entire chat history to find the "current best version" of a solution, leading to context window bloat.
- **Shared Vector Memory**: Rejected as it is too non-deterministic. A collaborative reasoning engine requires explicit attribution and versioning.

### 4.2 Reasoning for Blackboard Choice
The Blackboard approach mimics human scientific collaboration: a central "paper" (the state) is incrementally improved by peer review (the ACP transactions). This maximizes token efficiency and ensures a verifiable path to the result.

---

## 5. Operational Considerations

### 5.1 Failure Modes & Recovery
- **Agent Timeout**: If an agent fails to send `READY_TO_ACT` or a payload within a timeout window, the Choreographer marks the agent as `UNRESPONSIVE` and can either retry or re-assign the role to a fallback agent.
- **State Corruption**: Every ACP transaction is immutable. The Blackboard can be restored to any previous `transaction_id` for debugging.

### 5.2 Security & Access Control
- **Identity**: All payloads must be signed with the agent's Conclave private key.
- **Scoped Visibility**: The Choreographer determines which nodes an agent can "see" based on their role in the topology.

### 5.3 Observability
- **The War Room**: A real-time graph visualization of the Blackboard.
- **Metrics**: Track "Turns to Convergence" and "Crtique Efficiency" (how many critiques were actually incorporated into the final synthesis).

---

## 6. Implementation Plan

### Phase 1: MVP (The Socratic Loop)
- Implementation of the ACP Envelope.
- Basic Blackboard state storage (JSON/Postgres).
- Socratic Topology (2 agents).

### Phase 2: Scaling (The democratic Panel)
- Implementation of parallel agent activation.
- Synthesis logic.
- Basic "War Room" trace viewer.

### Phase 3: Robustness (Identity & Reputation)
- Conclave reputation-weighted consensus.
- Cryptographic signature verification for all ACP turns.
- Advanced Topology management.

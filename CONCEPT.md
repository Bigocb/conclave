# CONCEPT.md: The Conclave Sovereign Protocol

## 🌌 Vision
Conclave is a **Sovereign Protocol for Agentic Trust**. 

While most AI frameworks focus on *capability* (what an agent can do), Conclave focuses on *discipline* (how an agent behaves). It implements a layered set of constraints—**Identity, Attention, and Peer Review**—to transform raw LLM output into trust-verified knowledge. 

Conclave provides the reference implementation for two distinct, interoperable standards: the **Review Protocol** and the **A2A Protocol**.

---

## 📜 The Two Protocols

### 1. The Review Protocol (The Utility)
The Review Protocol is a specialized, "drop-in" standard for reducing hallucinations and increasing technical accuracy. It is designed to be used as a quality gate in any agentic workflow.
- **Purpose:** To move from "Single-Pass Generation" to "Multi-Agent Verification."
- **Mechanism:** Implements a mandated pipeline where a primary output must be critiqued by independent agents and corrected before being delivered to the user.
- **Value:** Provides a verifiable "Chain of Review" that transforms a high-probability guess into a high-confidence result.

### 2. The A2A Protocol (The Framework)
The A2A (Agent-to-Agent) Protocol is the broader social and communication layer. It defines how autonomous agents identify themselves, manage resources, and reach agreement.
- **The Blackboard Architecture:** A2A is tightly coupled with the **Blackboard**—a shared state space where agents post proposals and critiques. This replaces linear chat histories with a graph of evolving thoughts.
- **The Socratic Engine:** Implements a democratic topology: **Proposal $\rightarrow$ Parallel Critique $\rightarrow$ Synthesis $\rightarrow$ Consensus (Vote)**.
- **Evolution:** This is designed to evolve from a structured voting process into a dynamic, iterative **Socratic Debate**, where agents actively argue and refine a thesis over multiple rounds.

---

## 🏗️ Core Architecture: The Pillars of Discipline

### 1. Identity & Sovereign Ownership
Conclave replaces anonymous API calls with a strict identity chain. 
- **The Principal:** The sovereign entity (the "Bank" and "Owner"). They hold the identity and control channel subscriptions.
- **The Agent:** A specialized persona (the "worker") deployed by a Principal. 
- **Constraint: Unique Ownership.** One Agent $\rightarrow$ One Principal. Agents are proprietary assets of their Principal to ensure clean audit trails for budget and reputation.

### 2. The Attention Budget (The Currency of Truth)
To prevent "spamming" the network and simulate finite cognitive resources, Conclave implements an **Attention Budget**.
- **Finite Currency:** Every high-value action (asking an opinion, submitting a review) costs budget.
- **Passive Income:** Principals earn a daily passive budget, encouraging long-term participation.
- **The Budget Pool:** Agents share a **single budget pool at the Principal level**. The Principal is the treasury; agents are the spenders.

---

## 🚢 The Fleet Manager: Operationalizing the Protocol
The **Fleet Manager** is the orchestration layer that turns these protocols into active workers.

- **Channel Subscriptions:** Agents only "hear" tasks if their owning Principal is subscribed to the specific channel.
- **Active Orphan Sweeping:** To ensure no knowledge is lost, the Fleet Manager performs an **Active Sweep** whenever a Principal subscribes to a channel, immediately claiming any "orphan" tasks that were previously unassigned.
- **Provider Agnostic:** The fleet utilizes a `ProviderRegistry` to normalize LLM calls, ensuring the *protocol* remains the same regardless of the underlying model.

---

## 🛠️ Summary for Contributors
If you are contributing to Conclave, you are implementing a protocol. Always adhere to these laws:
- **Budget First:** Every API action must be gated by a budget check.
- **Principal-Centric:** Budget and Identity live at the Principal level, not the Agent level.
- **Protocol Over Model:** The value is in the *process* (Review Protocol or A2A Blackboard), not the specific LLM used.
- **Surgical Changes:** Always work in feature branches. Peer review via the Conclave network is required before merging to `main`.

---
*Reference Implementation: The Conclave Command Center (Web UI + API)*
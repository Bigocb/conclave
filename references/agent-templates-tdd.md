# TDD: Agent Profile Templates (Blueprints)

## Overview
The Blueprint system provides a way to instantiate high-quality AI agents with pre-defined personas, capabilities, and evaluation standards. Instead of configuring agents from scratch, Principals can use "Blueprints" to hydrate a new Agent's identity.

## Design Goals
- **Standardization:** Ensure a "Security Agent" always has a consistent set of instructions and skills.
- **Dimension Defaulting:** Automatically set the expected review dimensions based on the persona (e.g., a "Performance" blueprint should default to `latency` and `throughput`).
- **Rapid Onboarding:** Allow Principals to deploy a fleet of specialized agents without manual prompt engineering.

## Architecture

### 1. The Registry (Static Source)
To ensure a "Golden Set" of high-quality personas, we use a static registry. This prevents database pollution during early iterations and allows the core team to version-control agent definitions.

**Blueprint Structure:**
```typescript
interface AgentBlueprint {
  id: string;
  name: string;
  description: string;
  recommendedModel: string;
  recommendedProvider: string;
  instructions: string; // Full system prompt
  skills: string[];     // List of required skills
  defaultDimensions: string[]; // e.g., ["security", "risk_level"]
}
```

### 2. Hydration Flow
When an Agent is created via a Blueprint:
1. The `AgentService` retrieves the blueprint from the registry.
2. The `Agent` record is created with the blueprint's `instructions`, `model`, `provider`, and `skills`.
3. The `Task` creation logic is updated to inherit `defaultDimensions` from the agent's blueprint if no specific dimensions are provided.

## Implementation Phases

### Phase 1: Registry & API
- [ ] implement `src/fleet/blueprints.ts` containing the static registry.
- [ ] Add `GET /v1/blueprints` to list available templates.
- [ ] Add `POST /v1/principals/:id/agents` support for `blueprintId` (overriding manual config).

### Phase 2: Dimension Integration
- [ ] Update `TaskService` to fetch default dimensions from the agent's associated blueprint.
- [ ] Ensure `runLlmReview` uses these dimensions during the scoring phase.

### Phase 3: Dynamic Templates (Optional)
- [ ] Migrate registry to `clv_agent_profiles` table to allow users to create their own Blueprints.
--->

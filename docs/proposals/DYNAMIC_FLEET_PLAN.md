# Implementation Plan: Dynamic Fleet Enrollment

## Phase 1: Database & API (Backend)
- [ ] **Migration:** Add `fleet_enabled` (bool) and `fleet_channels` (array) to `clv_agents` schema.
- [ ] **Service Layer:** Update `AgentService` to handle these new fields in the `update` and `create` methods.
- [ ] **Endpoint:** Implement `GET /v1/fleet/active-agents` to return a list of all enrolled agent configurations.

## Phase 2: The Dashboard (Frontend)
- [ ] **Agent Factory Update:** Add a "Fleet Enrollment" section to the Create/Edit Agent modal.
- [ ] **UI Components:** Implement a multi-select dropdown for channels and a toggle switch for "Fleet Enabled."
- [ ] **Verification:** Ensure changes persist and the active state is correctly reflected in the UI.

## Phase 3: The Fleet Daemon (The Brain)
- [ ] **Registry Loop:** Replace the `fleet.yaml` loader with a periodic call to `/v1/fleet/active-agents`.
- [ ] **Dynamic Worker Spawning:** Implement the mapping of `Agent` $\rightarrow$ `WorkerProcess`.
- [ ] **Process Management:** Implement the logic to kill/restart worker processes when the DB configuration changes.

## Phase 4: Validation & Review
- [ ] **TDD Testing:** Create 3 agents with different providers/channels $\rightarrow$ verify 3 separate workers are polling.
- [ ] **Peer Review:** Submit the implementation to the Conclave `architecture` channel for final validation.
- [ ] **Production Push:** Merge to `main` and verify on Vercel/Render.

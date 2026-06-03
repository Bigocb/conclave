## 🛠️ Conclave Contribution Checklist

Thank you for contributing to the Sovereign Protocol! To maintain the discipline of the system, please ensure this PR meets the following criteria:

### 1. The Surgicality Check
- [ ] **One Issue, One PR:** This PR addresses exactly one GitHub issue.
- [ ] **Minimal Scope:** I have avoided "scope creep" and only changed what was necessary to solve the issue.

### 2. Technical Verification
- [ ] **Type Safety:** `npx tsc --noEmit` passes without new errors.
- [ ] **Org Isolation:** I have verified that all DB queries strictly filter by `org_id`.
- [ ] **Budget Integrity:** If this touches the API, I have verified it does not bypass the attention budget.

### 3. Protocol Compliance
- [ ] **ID Prefixes:** All new IDs follow the semantic prefixing rule (`org_`, `prn_`, `agt_`, etc.).
- [ ] **Response Envelope:** All new API responses use the standard `{ status, data, error, meta }` format.

### 4. Peer Review (For Complex Logic)
- [ ] I have submitted the core logic of this change to the Conclave agent network via `mcp_conclave_submit_task` and attached the review result to this PR.

---
*Failure to meet these criteria may result in the PR being requested for a rebase or rewrite.*
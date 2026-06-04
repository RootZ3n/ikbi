# ikbi Build State — Hermes Cross-Review Tracker

> Updated: 2026-06-02 (session end before mobile swap)

## Status: ALL FROZEN CORE PHASES COMPLETE

### Phases Cross-Reviewed by Hermes (all PASS, no freeze-forcing gaps)

| Phase | Component | Key Findings | Status |
|-------|-----------|--------------|--------|
| 0 | Service skeleton | Clean. Config/logging/server/systemd. | ✓ |
| 1 | Provider layer | H1: missing cachedTokens (fixed). H2: missing toolCalls on ModelMessage (fixed). H3: no reasoning field (fixed). AgentIdentity split into functionalRole/trustTier (fixed). | ✓ |
| 2 | Injection chokepoint | M1: buildWrapped exported without invariant check. M2: no documented gating thresholds. M3: no defang option for high-risk sources. All medium, none freeze-forcing. | ✓ |
| 3 | Agent identity | M1: no spawnedFrom (fixed). TrustTierResolver seam sufficient. Fail-closed posture correct. | ✓ |
| 4 | Concurrency substrate | H1: no AtomicAppendLog (fixed — added). DocumentStore correct for trust/workspaces. | ✓ |
| 5 | Receipt store | M1: no project field (fixed). 30-day retention = memory must persist projections. Tamper-evidence removed by design (lean log). | ✓ |
| 6 | Trust system | No gaps. Agent-trust only (no model-trust conflation). Autonomy mapping sufficient for gate wall + shadow-workspace. | ✓ |
| 7 | Event bus | No gaps. Drop-oldest acceptable for all consumers. Governance-critical paths use durable receipts, not transient bus. | ✓ |
| 8 | Workspace primitive | No gaps. Competitive build supported (N workspaces, judge evaluates each, promote winner). Promote atomic at ref level. | ✓ |

### What's Next: Parallel MODULE Phase

The frozen core is complete. Next phase is building independent modules against the contracts:

**Modules to build (from docs/ikbi-context.md):**
- Worker model (scout/builder/critic/verifier/integrator)
- Gate wall
- Drift prevention
- Cognition layer
- Caching/cost
- Deterministic subagent spawning
- Dependency-install
- Network egress (default-deny allowlist + SSRF floor)
- MCP wired into model tool-loop
- Governed sudo/curl
- Peh agent (router/intent/Q&A)
- Execution/shell monitoring + engine self-observation
- Dry-run/plan-only mode
- Graceful-degradation/kill-switch

**Build protocol:** CC and Hermes each own separate modules/files. Build to the contract. Integration = connecting matching endpoints.

### Key Architecture Decisions (Do Not Revisit)

1. Small frozen core defines all contracts; modules talk only through contracts
2. MiMo direct primary driver; mimo-v2.5-pro critic/reviewer; OpenRouter hardened backup
3. WWCCD rule: "Would a top coding agent do this?" baseline + deliberate extras
4. Receipts are retention-bounded (30-day) operational log, NOT a permanent ledger
5. Trust is agent-level only; model-trust is a separate module concern
6. Event bus is transient; governance-critical paths use durable receipts
7. Workspace promote is atomic at ref level (CAS update-ref); conflicts returned, not auto-resolved
8. Tamper-evidence removed from receipts (lean log for single-operator local engine)

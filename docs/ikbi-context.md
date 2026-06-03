# ikbi — build context & roadmap (shared orientation for all builders)

> Paste this at the top of each builder's session, or read it here — it is the
> orientation every builder (Claude Code, Hermes) works from. Local decisions
> are made with the whole shape in view, so that locally-correct work is also
> globally-correct.

## What ikbi is

The build-and-repair engine for a lab of AI agents. Choctaw for "to build." A
system service, reachable over Tailscale (localhost bind, never public). The
lab's main engine — autonomous agents are first-class callers, not just a human
operator. Greenfield rebuild from a proven design; no old code is carried over
(a prior version existed under the names "aedis"/"aiiska" — do not reference,
import, or look for it; everything is born ikbi / `IKBI_*`).

## The thesis (why ikbi is not just another harness)

It does everything a top-tier coding agent does, but tuned to run reliably and
cheaply on non-frontier models, fully governed and auditable for autonomous
agent use.

**Decision rule: WWCCD — "Would a top coding agent do this?"** If yes, it's
baseline (build it). If no, it's only included if it's part of the explicit
value-add package below.

## The value-add package (deliberate extras beyond baseline)

- **Peh** — an in-engine guide/teacher agent.
- **Cheap-model support.**
- **The shadow-workspace primitive** — run work in a disposable parallel
  workspace, used for competitive build with a deterministic judge, for
  trust-probation of models, and as a sandbox.
- **Drift prevention.**
- **A cognition layer.**
- **Aggressive caching + cost-saving.**
- **A governed/receipted/reversible posture** — nothing silent, everything
  auditable, everything undoable.

## Drivers

- **mimo-v2.5** direct API — primary (driver).
- **mimo-v2.5-pro** — critic/reviewer (proven to catch subtle issues).
- **OpenRouter** — hardened backup provider (circuit breaker, per-route timeout,
  deterministic fallback).
- Models AND providers are manually add/removable via config + CLI (no model
  loyalty; the roster changes).

## Architecture principle (critical for parallel builds)

A **SMALL FROZEN CORE** that defines all contracts, with everything else as
independent **MODULES** in their own files talking only through those contracts.
Two builders work in parallel by owning separate modules/files — never the same
file. Build to the contract; a module is done when it satisfies its contract in
isolation. Integration = connecting matching endpoints. This keeps the core
small and prevents cross-contamination.

## The roadmap (where any given task sits)

- **Phase 0:** clean repo skeleton — service, config, health/ready, structured
  logging, clean shutdown, systemd unit. (skeleton only, no engine logic)
- **Sequential spine — the FROZEN CORE:** provider layer (mimo + OpenRouter,
  hardened), prompt-injection chokepoint (scan-input + neutralize-wrap on every
  untrusted-content-into-model path), agent identity / multi-tenancy (every
  request knows which agent calls), concurrency-safe substrate (locking/atomic
  writes — concurrency the feature is deferred, but the core is safe for it),
  trust + receipt + store, event bus, the workspace primitive, versioned
  contracts, structured logging. Built first, frozen when verified — modules
  build against it, never modify it.
- **Parallel MODULES (built against the frozen core):** worker model
  (scout/builder/critic/verifier/integrator), the gate wall, drift prevention,
  cognition layer, caching/cost, deterministic subagent spawning,
  dependency-install, network egress (default-deny allowlist + SSRF floor), MCP
  wired into a model tool-loop, governed sudo/curl, the Peh agent
  (router/intent/Q&A + a ready endpoint for the deferred teacher),
  execution/shell monitoring + engine self-observation (status/health/queue),
  dry-run/plan-only mode, graceful-degradation/kill-switch.
- **Integration:** wire verified modules through their endpoints.
- **Late:** UI-ready API (must match the UI engine that already exists in the
  separate "Luak" repo — will be inspected when we get there), then a TUI.

## Deferred (do NOT build now; leave seams where noted)

- Concurrent multi-agent execution (core is built safe for it, feature comes
  later).
- Capability self-recovery.
- A small-model context-decomposition variant (separate future product).
- The graphical dashboard UI.
- The Peh teacher content (its endpoint is built now, content later).

## How we build

Claude Code is the main builder; Hermes (on mimo-pro) is the sub-builder and
cross-reviewer. Every piece is built by one and reviewed by the other before
commit. The core is built sequentially by CC; modules parallelize across both.
Each phase has a deliverable, a specific verification bar, and a commit. We
checkpoint between phases (verify against the bar, then proceed) — we do NOT
re-open settled decisions. Stop only if something breaks.

## Your job on any task

Build exactly what the phase prompt specifies, to its contract, verified. Don't
add scope, don't pull deferred items forward, don't reference old code. If a task
seems to conflict with this roadmap or a contract, flag it — don't silently
resolve it.

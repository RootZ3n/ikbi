# Phase 4 — Memory Governance

## Threat Model

"The forklift can tell a broken shelf from a load-bearing shelf now.
 Next we stop it from writing 'all shelves are suspicious' into permanent memory."

The threat: ikbi's model can write to durable surfaces that influence FUTURE runs.
Bad beliefs, bad memories, bad self-improvement rules — all persist and compound.

## Governed Surfaces

| Surface | Write path | Current governance |
|---------|-----------|-------------------|
| Knowledge brain (gbrain) | `brain_put` tool | NONE — model writes directly |
| `.ikbi/project.md` | `write_file`/`patch` | NONE |
| `.ikbi/checks.yaml` | `write_file`/`patch` | NONE |
| `.ikbi/ignore` | `write_file`/`patch` | NONE |
| `IKBI.md` | `write_file`/`patch` | NONE |
| `CLAUDE.md` | `write_file`/`patch` | NONE |
| `AGENTS.md` | `write_file`/`patch` | NONE |

**NOT governed** (already safe):
- `lab-context-memory.record()` — identity-gated, size-capped, scrubbed
- Session memory — in-memory only, not persisted
- Trust state — MAC-protected, engine-internal
- `brain_sync` — already identity-gated

## Core Principle

**PROPOSE ONLY. No unattended durable writes to memory surfaces.**

The model can PROPOSE changes. An operator REVIEWS and APPROVES.
Only approved proposals are applied.

This is NOT a restriction on the model's ability to learn — it's a REVIEW LAYER.
The model can still identify what should be remembered; it just can't install it
without human review.

## Proposal Lifecycle

```
Model calls brain_put(".ikbi/project.md", "Always use pytest")
    │
    ▼
┌─────────────────────────────────────┐
│ Memory Governor intercepts          │
│ → stores proposal (pending)         │
│ → returns "PROPOSED: pending review" │
└─────────────────────────────────────┘
    │
    ▼
Operator runs: ikbi memory proposals
    │
    ▼
┌─────────────────────────────────────┐
│ Operator reviews proposals:         │
│   ikbi memory approve <id>          │
│   ikbi memory reject <id>           │
│   ikbi memory reject-all            │
└─────────────────────────────────────┘
    │
    ▼
Approved proposal → applied to surface
Rejected proposal → discarded (logged)
```

## Implementation

### New module: `src/modules/memory-governor/`

**contract.ts** — MemoryProposal, MemoryGovernor interface, governed paths
**store.ts** — DocumentStore-backed proposal persistence
**guard.ts** — `isGovernedPath()`, `isGovernedBrainSlug()` checks
**index.ts** — factory, singleton

### Integration points

1. **builder.ts brain_put dispatch** (line ~1418):
   Before `runBrainCall`, check if `call.name === "brain_put"`.
   If governed → store proposal → return "PROPOSED:" message.

2. **builder.ts write_file dispatch** (line ~756):
   After confinement check, before actual write.
   Check `isGovernedPath(rel)` → store proposal → return "PROPOSED:".

3. **builder.ts patch dispatch** (line ~852):
   Same check — if any hunk targets a governed path → propose.

### CLI: `ikbi memory`

```
ikbi memory proposals              # list pending proposals
ikbi memory proposals --all        # include approved/rejected
ikbi memory approve <id>           # approve and apply a proposal
ikbi memory reject <id>            # reject a proposal
ikbi memory reject-all             # reject all pending proposals
ikbi memory stats                  # proposal counts by status
```

## Tests

1. Proposal lifecycle: create → pending → approve → applied
2. Proposal lifecycle: create → pending → reject → discarded
3. Guard: `isGovernedPath(".ikbi/project.md")` → true
4. Guard: `isGovernedPath("src/index.ts")` → false
5. Guard: `isGovernedBrainSlug("notes/convention")` → true
6. Integration: brain_put → intercepted → proposal stored
7. Integration: write_file to governed path → intercepted → proposal stored
8. Integration: write_file to non-governed path → NOT intercepted
9. CLI: proposals listing, approve, reject, reject-all
10. Edge: duplicate proposal (same surface + target) → upserts

## Exit Criteria

- [ ] `brain_put` writes are intercepted → proposals
- [ ] File writes to governed paths → intercepted → proposals
- [ ] Non-governed writes pass through untouched
- [ ] CLI lists, approves, rejects proposals
- [ ] All tests green
- [ ] Tagged `ikbi-memory-governor-v1`

# ikbi Enhancement Plan — Borrowed from Aura, Built for ikbi
## "Borrow the idea, not the name or code."

---

## Gap Analysis

**ikbi has 33 modules. 5 are dormant (built but not wired):**
- `project-index` — file map, package graph, import graph (DELIBERATELY UNWIRED)
- `step-planner` — goal decomposition (NOT wired in production)
- `verification-ladder` — deterministic verification planner (library-only)
- `check-triage` — check classification (library-only)
- `dependency-install` — dependency management (library-only)

**Aura's advantage isn't deeper modules — it's a visible product surface.**
Aura wired everything into: plan → approve → execute → validate → receipt.
ikbi has deeper machinery but 5 key modules sitting dormant.

---

## Feature 1: Job Cards (ikbi's version of Aura's "Drones")

### What Aura does
- Reusable AI workers created from natural language prompts
- Project-local, version-controlled manifests
- Read-only vs write-capable policies
- Loopable runs with guardrails (clean worktree, max files, protected paths)
- Visual Workbay canvas for drag-and-drop chaining
- Planner can summon saved Drones when it detects relevant tasks

### What ikbi builds: **Job Cards**

A Job Card is a saved, named, bounded automation with:
- **Name + description** (human-readable)
- **Goal template** (parameterized prompt)
- **Access policy**: `read-only` | `write-gated` | `write-auto`
- **Guardrails**: max_files_changed, protected_paths, require_clean_worktree
- **Verification**: required | optional | skip
- **Rollback**: on-failure | never | always
- **Schedule**: once | loop (with interval)
- **Trust requirement**: minimum trust tier to execute
- **Receipts**: every run produces a receipt linked to the job card

### Built-in Job Cards (shipped with ikbi)

| Card Name | Access | Purpose |
|-----------|--------|---------|
| **Repo Gardener** | read-only → write-gated | Find god files, stale docs, unused exports. One bounded refactor per lap. |
| **Receipt Doctor** | read-only | Audit receipts for gaps, anomalies, missing verification. Report only. |
| **Dependency Mapper** | read-only | Map dependency graph, find circular deps, flag outdated packages. |
| **Docs Drift Auditor** | read-only | Compare docs to code, find stale READMEs, missing JSDoc. |
| **Test Gap Finder** | read-only | Find untested code paths, suggest test locations. |
| **Security Sweep** | read-only | Scan for hardcoded secrets, unsafe patterns, injection risks. |
| **Refactor Planner** | read-only | Analyze code structure, suggest bounded refactors with blast radius. |
| **Import Cleaner** | write-gated | Remove unused imports, fix import order. Max 5 files per run. |

### Implementation

```
src/modules/job-cards/
  contract.ts    — JobCard, JobCardRun, JobCardResult types
  store.ts       — JSON-file-backed store (like ops panel)
  runner.ts      — Executes job cards through worker-model
  builtins.ts    — Built-in card definitions
  index.ts       — Module entrypoint
  index.test.ts  — Tests
```

### Routes (added to ikbi server)

```
GET    /ikbi/job-cards              — list all job cards
GET    /ikbi/job-cards/:id          — get card details
POST   /ikbi/job-cards              — create custom card
PATCH  /ikbi/job-cards/:id          — update card
DELETE /ikbi/job-cards/:id          — delete card
POST   /ikbi/job-cards/:id/run      — execute a job card
GET    /ikbi/job-cards/:id/runs     — list run history
GET    /ikbi/job-cards/:id/runs/:rid — get specific run details
```

---

## Feature 2: Repo Doctor (ikbi's repo intelligence surface)

### What Aura does
- AST repo map in system prompts
- BM25 full-text search across 1500 files
- Dependency graph awareness
- Visible to the user as a first-class concept

### What ikbi builds: **Repo Doctor**

Wire `project-index` (currently dormant) into a visible surface.

**Step 1: Activate project-index**
- Wire into the scout/builder flow so agents see repo structure
- Expose via API for the Ops Panel

**Step 2: Build Repo Doctor analysis**
- **File health**: oversized files (>500 lines), god files, dead code
- **Dependency health**: circular deps, outdated packages, missing lockfile
- **Test health**: coverage gaps, flaky test patterns, untested modules
- **Doc health**: stale READMEs, missing JSDoc, outdated examples
- **Import health**: unused imports, circular imports, barrel abuse
- **Structure health**: deep nesting, inconsistent naming, mixed concerns

**Step 3: Expose in Ops Panel**
- New "Repo Doctor" tab in Ittunaha Ops Panel
- Shows health scores per dimension
- Links to specific files/lines
- "Run Repo Doctor" button triggers a scan

### Implementation

```
src/modules/repo-doctor/
  contract.ts    — HealthReport, HealthDimension, HealthFinding types
  analyzers/
    file-health.ts      — oversized files, god files
    dependency-health.ts — circular deps, outdated
    test-health.ts       — coverage gaps
    doc-health.ts        — stale docs
    import-health.ts     — unused imports
    structure-health.ts  — nesting, naming
  index.ts       — Runs all analyzers, produces report
  index.test.ts  — Tests
```

### Routes

```
GET    /ikbi/repo-doctor/health     — full health report
GET    /ikbi/repo-doctor/health/:dim — single dimension
POST   /ikbi/repo-doctor/scan       — trigger fresh scan
GET    /ikbi/repo-doctor/history    — past scan results
```

---

## Feature 3: Spec Artifact (Token Firewall)

### What Aura does
- Planner writes a structured technical spec
- User can review and edit the spec before dispatch
- Spec acts as a clean boundary — planner's reasoning noise doesn't affect worker
- Achieves 90%+ prompt cache hit rates

### What ikbi builds: **Spec Artifact**

ikbi already has `step-planner` (dormant). Wire it and make the output a first-class editable artifact.

**Step 1: Activate step-planner**
- Wire into the `ikbi build` CLI flow
- Before executing, generate a step plan
- Present the plan as an editable artifact

**Step 2: Spec as first-class artifact**
- Store specs alongside receipts
- User can edit spec before execution
- Spec becomes the "contract" between planning and execution
- Worker only sees the spec, not the planner's reasoning

**Step 3: Cache optimization**
- Spec structure enables prefix caching
- Track cache hit rates per spec
- Report cost savings

### Implementation

```
src/modules/spec-artifact/
  contract.ts    — SpecArtifact, SpecEdit, SpecVersion types
  store.ts       — Spec storage (file-backed)
  presenter.ts   — Format spec for human review
  index.ts       — Module entrypoint
  index.test.ts  — Tests
```

### Routes

```
POST   /ikbi/spec/generate     — generate spec from goal
GET    /ikbi/spec/:id          — get spec
PATCH  /ikbi/spec/:id          — edit spec
POST   /ikbi/spec/:id/execute  — execute edited spec
GET    /ikbi/spec/:id/status   — execution status
```

---

## Implementation Order

1. **Job Cards** — highest value, most visible, enables everything else
2. **Repo Doctor** — wires dormant modules, visible health surface
3. **Spec Artifact** — wires step-planner, cache optimization

Each feature is independent. Can be built in parallel.

---

## What We're NOT Stealing

- **Workbay canvas** — ikbi has Ops Panel, not a desktop IDE. Different UX paradigm.
- **Mobile companion** — ikbi already has Matrix integration via Hermes. Different approach.
- **BM25 search** — project-index already has import graph. BM25 is a nice-to-have, not critical.
- **Desktop IDE shell** — ikbi is a system service, not a desktop app. Different architecture.

## What We ARE Stealing

- **Reusable bounded automations** → Job Cards
- **Visible repo intelligence** → Repo Doctor
- **Spec as first-class artifact** → Spec Artifact
- **"I know what is happening" UX** → Wire dormant modules into visible surfaces

---

## Success Criteria

- [ ] Job Cards: 8 built-in cards, CRUD API, execution through worker-model, receipts
- [ ] Repo Doctor: 6 health dimensions, API, Ops Panel integration
- [ ] Spec Artifact: step-planner wired, editable specs, execution through worker-model
- [ ] All new modules have tests (target: 50+ new tests)
- [ ] All existing tests still pass (2199+)
- [ ] No regressions in trust, governance, or safety

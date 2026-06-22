# ikbi Capability Map

> Every module, what it does, when it activates, what fails it, and whether it's wired in.

## The Pipeline (what happens on every `ikbi build <goal>`)

```
Goal → Cognition Layer → Scout → Builder → Verifier → Critic → [Refuter] → Integrator
         (classify)      (read)  (write)   (check)    (judge)   (refute)   (promote/discard)
```

### Role 1: Scout (read-only)
- **What**: Gathers repo context — file structure, dependencies, existing tests
- **When**: First role in every build run
- **Fail state**: Cannot read workspace / repo structure unavailable
- **Wired**: ✓ orchestrator dispatches it

### Role 2: Builder (read-write)
- **What**: Runs the model + tool loop, makes changes in the workspace
- **When**: After scout succeeds
- **Fail state**: Model timeout, tool execution failure, max iterations exceeded
- **Wired**: ✓ orchestrator dispatches it
- **Modes**: `agent` (tool-calling) or `patch` (unified diff, for cheap models)

### Role 3: Verifier (read-only, deterministic)
- **What**: Runs `tsc --noEmit` + `pnpm test` against the workspace
- **When**: After builder succeeds
- **Fail state**: Tests fail, typecheck fails, stub script detected, script mutation detected
- **Wired**: ✓ orchestrator dispatches it
- **Modes**: `ladder` (hardened, default) or `legacy` (fixed checks)

### Role 4: Critic (read-only, model-driven)
- **What**: Semantic review — does the change satisfy the goal?
- **When**: After verifier succeeds
- **Fail state**: Model says FAIL, goal_correctness below threshold, parse failure
- **Wired**: ✓ orchestrator dispatches it

### Role 5: Refuter (read-only, adversarial) ⚡ NEW
- **What**: Explicitly tries to REFUTE the build — "find what is broken"
- **When**: After critic succeeds (optional, `IKBI_REFUTER=true`)
- **Fail state**: Critical findings (stub scripts, weakened tests, forbidden files, conflict markers)
- **Wired**: ✓ orchestrator dispatches it (when enabled)
- **Auto-proposes corrections** to the correction library on critical findings

### Role 6: Integrator (decision)
- **What**: Makes the promote/discard decision based on all prior results
- **When**: Last role in the pipeline
- **Fail state**: Any prior role failed → discard
- **Wired**: ✓ orchestrator dispatches it

---

## Supporting Modules

### Core Infrastructure (always active)

| Module | What | When | Fail State | Wired |
|--------|------|------|------------|-------|
| **egress** | SSRF fetch guard | Every model invocation | Guard missing → model call blocked | ✓ barrel |
| **gate-wall** | Authorization gate | Every governed operation | Unauthorized → denied | ✓ barrel |
| **governed-exec** | Sandboxed command execution | Verifier checks, tool calls | Non-allowlisted binary → denied | ✓ barrel |
| **trust** | Trust tier system | Every identity resolution | Invalid tier → floor tier | ✓ barrel |
| **cache** | Response caching | Model invocations | Cache miss → fresh call | ✓ barrel |
| **kill-switch** | Emergency stop | Operator command | Activated → all builds blocked | ✓ barrel |
| **identity** | Agent identity + tokens | Every request | Invalid token → rejected | ✓ core |

### Build Pipeline Support

| Module | What | When | Fail State | Wired |
|--------|------|------|------------|-------|
| **escalation** | Model-tier escalation | After builder failure | Score too low → no escalation | ✓ barrel |
| **verification-ladder** | Package-aware verification | Verifier in ladder mode | Stub detected → fail closed | ✓ used by verifier |
| **project-index** | Repo structure map | Ladder verification, repo doctor | Index build failure → fallback | ✓ used by verifier, repo-doctor |
| **check-triage** | Check output parsing | Verifier, builder, chat | Parse failure → raw output | ✓ used by verifier, builder |
| **deterministic-judge** | Competitive candidate scoring | Tournament mode | No candidates → skip | ✓ used by orchestrator |
| **context-packets** | Byte-budgeted task packets | Model invocations | Budget exceeded → truncate | ✓ barrel |
| **model-evaluation** | Benchmark verifiers | Tournament, capability harness | Benchmark failure → skip | ✓ barrel |
| **dependency-install** | Auto-install deps | Builder tool calls | Install failure → tool blocked | ✓ barrel |

### Agent Routing

| Module | What | When | Fail State | Wired |
|--------|------|------|------------|-------|
| **agent-router** | Classify + route requests | Every `ikbi ask` | Misclassification → wrong agent | ✓ barrel |
| **cognition-layer** | Goal classification + routing | `ikbi <goal>` (bare goal) | Classification failure → default route | ✓ CLI entry |
| **batch-planner** | Multi-task decomposition | `ikbi batch` command | Decomposition failure → single task | ✓ barrel |
| **step-planner** | Multi-step execution | Spec artifact execution | Step failure → abort sequence | ✓ used by spec-artifact |
| **subagent-spawning** | Delegate to sub-agents | Complex tasks | Spawn failure → inline execution | ✓ barrel |

### Memory + Context

| Module | What | When | Fail State | Wired |
|--------|------|------|------------|-------|
| **lab-context-memory** | Receipt-projected DocumentStore | Every build | Memory load failure → empty context | ✓ barrel |
| **labmem-recall** | Read lab-wide memory | Chat, build context | Labmem unavailable → skip | ⚠️ NOT in barrel (library-only) |
| **memory-governor** | Memory governance proposals | Chat sessions, builds | Proposal rejected → no change | ⚠️ NOT in barrel (library-only) |
| **project-retrieval** | File retrieval for context | Scout role | File not found → empty context | ✓ used by scout |

### Self-Healing

| Module | What | When | Fail State | Wired |
|--------|------|------|------------|-------|
| **self-observation** | Health monitoring | Continuous | Monitor failure → silent | ✓ barrel |
| **self-repair** | Auto-diagnose + file work orders | `ikbi doctor --self-repair` | Diagnosis failure → manual | ✓ barrel |
| **capability-recovery** | Diagnostic for capability gaps | `ikbi recover` command | Recovery failure → manual | ✓ barrel |
| **drift-prevention** | Detect capability drift | Capability recovery, cognition | Drift detected → warning | ✓ used by recovery, cognition |

### Product Surface

| Module | What | When | Fail State | Wired |
|--------|------|------|------------|-------|
| **job-cards** | 8 reusable automations | User triggers via UI/CLI | Card execution failure → rollback | ✓ barrel + routes |
| **repo-doctor** | 6-dimension health analysis | User triggers via UI/CLI | Analysis failure → partial report | ✓ barrel + routes |
| **spec-artifact** | Editable plans from goals | User generates spec | Generation failure → manual spec | ✓ barrel + routes |
| **correction-library** | Reusable lessons from failures | Refuter proposes, operator approves | Correction rejected → not applied | ✓ barrel + routes |
| **chat** | Conversational interface | `POST /chat` endpoint | Token invalid → rejected | ✓ barrel + routes |
| **mcp-model-loop** | MCP tool integration | Builder with MCP tools | MCP server down → no tools | ✓ barrel |

### Security

| Module | What | When | Fail State | Wired |
|--------|------|------|------------|-------|
| **execution-policy** | Execution policy rules | Gate-wall, governed-exec | Policy violation → blocked | ✓ used by gate-wall, governed-exec |
| **capability-client** | Lab capability ledger | Agent routing | Ledger down → static fallback | ✓ barrel |
| **capability-registry** | Local capability registry | Capability queries | Registry empty → no capabilities | ⚠️ NOT in barrel (library-only) |

---

## Dormant Modules (built but not wired into product surface)

| Module | Status | What It Does | Why Dormant |
|--------|--------|--------------|-------------|
| **labmem-recall** | Library-only | Read lab-wide shared memory | ikbi reads labmem through lab-context-memory; direct access not needed |
| **memory-governor** | Library-only | Govern memory proposals | Used internally by chat/builder; no direct user surface |
| **capability-registry** | Library-only | Local capability registry | Used by capability-client; no direct user surface |

---

## API Endpoints

| Endpoint | Method | Module | What |
|----------|--------|--------|------|
| `/health` | GET | server | Liveness check |
| `/ready` | GET | server | Readiness check |
| `/agent` | GET | server | Agent identity |
| `/capabilities` | GET | server | Tool inventory + features |
| `/chat` | POST | chat | Conversational interface |
| `/api/build` | POST | tasks | External build request |
| `/api/fix` | POST | tasks | External fix request |
| `/api/tasks` | GET | tasks | List tasks |
| `/api/tasks/:id` | GET | tasks | Get task |
| `/api/tasks/:id/cancel` | POST | tasks | Cancel task |
| `/api/tasks/:id/stream` | GET | task-stream | SSE progress stream |
| `/api/receipts` | GET | receipts | Build history |
| `/api/receipts/:id` | GET | receipts | Single receipt |
| `/api/timeline` | GET | timeline | Activity timeline |
| `/ikbi/job-cards` | GET | job-cards | List job cards |
| `/ikbi/job-cards/:id` | GET | job-cards | Get card |
| `/ikbi/job-cards` | POST | job-cards | Create card |
| `/ikbi/job-cards/:id` | PATCH | job-cards | Update card |
| `/ikbi/job-cards/:id` | DELETE | job-cards | Delete card |
| `/ikbi/repo-doctor/health` | GET | repo-doctor | Health analysis |
| `/ikbi/spec/generate` | POST | spec-artifact | Generate spec |
| `/ikbi/spec/:id` | GET | spec-artifact | Get spec |
| `/ikbi/spec/:id` | PATCH | spec-artifact | Edit spec |
| `/ikbi/spec/:id/execute` | POST | spec-artifact | Execute spec |
| `/ikbi/corrections` | GET | correction-library | List corrections |
| `/ikbi/corrections` | POST | correction-library | Propose correction |
| `/ikbi/corrections/:id` | GET | correction-library | Get correction |
| `/ikbi/corrections/:id/approve` | PATCH | correction-library | Approve |
| `/ikbi/corrections/:id` | DELETE | correction-library | Reject/delete |

## CLI Commands

| Command | File | What |
|---------|------|------|
| `ikbi build <goal>` | worker-model/cli.ts | Run the full pipeline |
| `ikbi fix <goal>` | cli/fix.ts | Diagnose + repair failing checks |
| `ikbi audit <repo>` | cli/audit.ts | Read-only diagnostic snapshot |
| `ikbi cost` | cli/cost.ts | Per-task cost breakdowns |
| `ikbi receipts` | cli/receipts.ts | Show receipt history |
| `ikbi memory` | cli/memory.ts | Memory governance proposals |
| `ikbi clean` | cli/clean.ts | Reclaim orphaned worktrees |
| `ikbi undo` | cli/undo.ts | Undo a promote |
| `ikbi web` | cli/serve.ts | Start the web dashboard |
| `ikbi doctor` | cli/doctor.ts | Self-diagnostic |
| `ikbi recover` | capability-recovery | Capability gap diagnostic |
| `ikbi trust` | trust | Trust tier management |
| `ikbi batch` | batch-planner | Multi-task decomposition |
| `ikbi <goal>` | cognition-layer | Auto-classify + dispatch |

---

## Dashboard Windows

| Window | Default | What |
|--------|---------|------|
| **Runtime TUI** | Always on | Terminal-style build status, logs, command bar |
| **Chat with Peh** | Always on | Conversation with Peh (medicine man persona) |
| **Job Cards** | Open | 8 built-in automations with Run buttons |
| **Repo Doctor** | Open | 6-dimension health analysis with scores |
| **Spec Artifact** | Hidden | Editable plans with execute button |
| **Build History** | Hidden | Receipt timeline |
| **Modules** | Hidden | 33 module status tiles |
| **Configuration** | Hidden | Model, provider, lifecycle flags |
| **Corrections** | Hidden | Correction library with approve/reject |

---

## The Loop (ikbi's maturity model)

```
Spec → Build → Verify → Refute → Fix → Record Correction → Reuse Next Run
  ↑                                                              ↓
  └──────────────────────────────────────────────────────────────┘
```

1. **Spec**: User writes a structured spec card (PROJECT/GOAL/SCOPE/RULES/OUTPUT/ON CONFLICT)
2. **Build**: Builder runs model + tool loop against the spec
3. **Verify**: Deterministic checks (tsc + tests) prove it works
4. **Refute**: Adversarial refuter tries to find what's broken
5. **Fix**: If refuted, fix loop repairs and re-verifies
6. **Record**: Every critical finding becomes a proposed correction
7. **Reuse**: Approved corrections feed back into future verifier/refuter decisions

This is how ikbi "gets sharper without lying to itself."

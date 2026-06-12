# Patchsmith Builder Lane + Model Capability Harness

## The Insight
Stop asking "why won't this model behave?" — start asking "what job can this model reliably do?"

DeepSeek V4 Flash is not an autonomous agent builder. It IS a cheap patch candidate generator. Route it to the right lane instead of adding scaffolding.

## Architecture: Two Builder Lanes

### Agent Builder (existing path)
- Tool-calling loop (16 tools)
- Can inspect files, run checks, decide next action
- Only models that PROVE they can behave go here
- Current path — unchanged

### Patchsmith Builder (new path)
- No tools, no shell, no wandering
- ikbi gathers context (relevant files, failing test output, task description)
- Model returns ONE unified diff / structured patch
- ikbi applies the patch in a managed workspace
- ikbi runs ladder verification
- If verification fails, ikbi sends failure output back for ONE repair attempt
- After max repair attempts, fail closed

## Model Capability Harness

### Fixtures (3 minimum)
1. **one-file bug fix** — fix a failing test by changing one file
2. **add missing edge-case handling** — add logic without touching tests
3. **repair a TypeScript compile error** — fix a type error

Each fixture has:
- initial repo state (git worktree)
- failing command (the test/typecheck that fails)
- expected constraints (forbidden files, forbidden behaviors)
- verification command (how to prove the fix works)

### Scorecard
```
model: deepseek-v4-flash
tool_call_reliability: 0.3    (3/10 tool calls correct)
schema_reliability: 0.5       (5/10 JSON parses valid)
patch_parseability: 0.9       (9/10 patches parse as valid diff)
diff_minimality: 0.8          (8/10 changes are minimal)
test_boundary_respect: 0.7    (7/10 don't modify tests when forbidden)
target_test_pass: 0.6         (6/10 patches fix the target test)
full_verification_pass: 0.4   (4/10 patches pass full verification)
repair_success_rate: 0.5      (5/10 repairs fix the issue)
overclaiming_rate: 0.2        (2/10 claim success without evidence)
recommended_role: patch_builder
routing_reason: fails autonomous agent (tool_call 0.3, schema 0.5),
  viable patch generator (parseability 0.9, minimality 0.8)
```

### Routing Rules
- tool_call_reliability >= 0.7 AND schema_reliability >= 0.7 → agent_builder
- patch_parseability >= 0.7 AND diff_minimality >= 0.6 → patch_builder
- repair_success_rate >= 0.5 → repair_builder (can do repair after verifier)
- target_test_pass >= 0.5 AND overclaiming_rate <= 0.3 → critic_only
- else → not_recommended

## Receipts
Every patchsmith run records:
- model used
- builder mode (patch_builder / agent_builder)
- patch attempt count
- files supplied to model (context)
- files changed by patch
- verification result (ladder)
- repair attempts (count + outcome)
- routing reason (why this model is in this lane)

## Tests
1. patch-only builder cannot call tools (no tool schema in request)
2. patch-only builder cannot promote without verification
3. malformed patch fails closed
4. patch that changes forbidden files is rejected
5. patch that passes target test but fails full verification does not promote
6. repair attempt receives verifier output and can fix patch
7. capability harness classifies noisy tool model as patch_builder
8. capability harness classifies unparseable-patch model as not_recommended

## Acceptance
- pnpm typecheck
- pnpm test (all existing + new)
- existing build path unchanged
- existing managed REPL path unchanged
- no unverified promote/apply path added
- cheap model failure → useful capability scorecard (not vague "failed build")

## Implementation Plan
1. Add `builderMode` to WorkerTask contract (agent | patch)
2. Add patchsmith builder function (no tools, context → patch → apply → verify)
3. Add model capability harness (3 fixtures, scorecard generator)
4. Add routing logic (scorecard → builder mode)
5. Wire into orchestrator (mode-aware dispatch)
6. Add receipt fields (model, mode, attempts, routing reason)
7. Add all tests
8. Build + typecheck + test

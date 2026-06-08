# ikbi Codebase Audit Report

Date: 2026-06-08

Scope: `src/` was treated as source of truth. `dist/` is generated output and was not used for behavioral conclusions. I checked entrypoints, module barrels, CLI/HTTP registration, worker builder/chat tool loops, MCP transport, cognition/drift call paths, and import reachability.

## Executive Summary

The codebase is mostly wired through the `src/modules/index.ts` activation barrel, but "import-reachable" does not always mean "operationally invoked." The builder's 16-tool loop is fully declared and dispatched. The `/chat` loop is wired, but it intentionally or accidentally exposes only 13 of those tools: it does not have `scout_detail`, `run_checks`, or `done`, so it does not have "ALL the same tools as the builder." The context compressor is actually invoked in the builder loop before each model call.

The cognition layer is not dead code: it is the CLI fallback for bare goals and can auto-dispatch recommended commands. It is not wired into the HTTP server or into the worker-model build pipeline. Drift-prevention is not dead code either: it is consulted by cognition-layer and capability-recovery, but it is advisory/read-only and does not prevent or intervene in anything.

The MCP stdio transport is a real implementation, not just a stub, but it is opt-in only. The default process-wide MCP model loop still uses the mock transport and no CLI/HTTP entrypoint wires stdio for an operator.

## Findings

### 1. Cognition layer is wired into CLI fallback, not the build pipeline

Status: partially wired, not dead code.

Evidence:

- `src/cli/index.ts:28` imports `createCognitionRouter` directly from `../modules/cognition-layer/index.js`.
- `src/cli/index.ts:50-51` creates the default cognition router with `dispatch: dispatchCommand`.
- `src/cli/index.ts:151-160` dispatches known module commands first; unknown input falls through to `cognitionRouter.route(argv)`.
- `src/modules/cognition-layer/cli.ts:133-158` parses a bare goal, resolves operator identity, starts an operation, and calls `cognition.deliberate(...)`.
- `src/modules/cognition-layer/cognition.ts:137-184` performs the actual model deliberation and publishes `cognition.decided`.

Limits:

- `src/modules/index.ts:25-49` does not import `cognition-layer`. The CLI imports cognition directly, so CLI bare-goal routing works, but the service activation barrel does not activate cognition by itself.
- `src/modules/worker-model/orchestrator.ts:400-420` dispatches roles directly from `WORKER_ROLES`; cognition is not part of the worker build flow.

Conclusion: cognition-layer is live for `ikbi <goal...>` CLI usage. It is not part of `/chat`, HTTP, or the worker-model role loop.

### 2. Drift-prevention is used, but advisory only

Status: used transitively; not an active prevention mechanism.

Evidence:

- `src/modules/cognition-layer/cognition.ts:20` imports `driftPrevention` from `../drift-prevention/index.js`.
- `src/modules/cognition-layer/cognition.ts:146-153` calls `drift.check(...)` when a project is present, filters drifted reports, and tolerates drift read failures.
- `src/modules/cognition-layer/cognition.ts:156-161` folds drift signals into the cognition system prompt.
- `src/modules/capability-recovery/recovery.ts:24` imports `driftPrevention`.
- `src/modules/capability-recovery/recovery.ts:193-201` calls `drift.check(...)` when a project is present.
- `src/modules/capability-recovery/recovery.ts:203-208` adds drift signals to recovery diagnosis.

Limits:

- `src/modules/drift-prevention/drift.ts:4-8` explicitly describes the module as read-only and non-acting.
- `src/modules/drift-prevention/drift.ts:23-24` defines the default policy as `reportOnly`.
- `src/modules/drift-prevention/drift.ts:124-126` calls the policy but performs no intervention even when drift is detected.

Conclusion: drift-prevention is not sitting entirely unused, but the name overstates current behavior. It detects and reports drift; it does not prevent, block, demote, halt, or reroute anything.

### 3. Builder has 16 tools, and all 16 are wired in the builder loop

Status: builder wiring is complete.

The builder declares 16 tools in `src/modules/worker-model/builder.ts:127-200`:

1. `read_file` at `src/modules/worker-model/builder.ts:128-132`
2. `write_file` at `src/modules/worker-model/builder.ts:133-141`
3. `list_dir` at `src/modules/worker-model/builder.ts:142-146`
4. `search_files` at `src/modules/worker-model/builder.ts:148`
5. `patch` at `src/modules/worker-model/builder.ts:149`
6. `terminal` at `src/modules/worker-model/builder.ts:150`
7. `git_status` at `src/modules/worker-model/builder.ts:152`
8. `git_diff` at `src/modules/worker-model/builder.ts:153`
9. `git_log` at `src/modules/worker-model/builder.ts:154`
10. `web_search` at `src/modules/worker-model/builder.ts:156`
11. `web_extract` at `src/modules/worker-model/builder.ts:157`
12. `delegate_task` at `src/modules/worker-model/builder.ts:159`
13. `vision_analyze` at `src/modules/worker-model/builder.ts:161`
14. `scout_detail` at `src/modules/worker-model/builder.ts:165-172`
15. `run_checks` at `src/modules/worker-model/builder.ts:178-181`
16. `done` at `src/modules/worker-model/builder.ts:186-198`

Dispatch evidence:

- File/list/search/patch/scout_detail dispatch through `runTool` at `src/modules/worker-model/builder.ts:519-586`.
- `terminal` dispatches at `src/modules/worker-model/builder.ts:869-873`.
- `git_status` / `git_diff` / `git_log` dispatch at `src/modules/worker-model/builder.ts:874-877`.
- `web_search` / `web_extract` dispatch at `src/modules/worker-model/builder.ts:878-882`.
- `delegate_task` dispatches at `src/modules/worker-model/builder.ts:883-886`.
- `vision_analyze` dispatches at `src/modules/worker-model/builder.ts:887-890`.
- `run_checks` dispatches at `src/modules/worker-model/builder.ts:862-868`.
- `done` dispatches at `src/modules/worker-model/builder.ts:846-861`.

Conclusion: all 16 builder tools are declared to the model and have loop dispatch paths.

### 4. Chat session is wired, but has only 13 of the 16 builder tools

Status: chat loop is real; tool parity claim is false.

Evidence:

- `/chat` is registered by `src/modules/chat/routes.ts:29-40`.
- `src/modules/chat/index.ts:21-22` side-effect imports `./routes.js`.
- `src/modules/index.ts:39-40` imports chat, so the HTTP service loads the route.
- `src/modules/chat/session.ts:134-148` declares `CHAT_TOOLS`.
- `src/modules/chat/session.ts:368-375` sends `tools: CHAT_TOOLS` to the model.
- `src/modules/chat/session.ts:220-319` dispatches every declared chat tool.

Chat tools present: `read_file`, `write_file`, `list_dir`, `search_files`, `patch`, `terminal`, `git_status`, `git_diff`, `git_log`, `web_search`, `web_extract`, `delegate_task`, `vision_analyze`.

Missing compared with builder:

- `scout_detail`
- `run_checks`
- `done`

This is visible by comparing `src/modules/worker-model/builder.ts:127-200` with `src/modules/chat/session.ts:134-148`.

Conclusion: `/chat` does not have all the same tools as the builder. It has 13 of 16. If parity is intended, chat is missing three tools. If conversational chat is intentionally not supposed to have builder-only terminator/check/scout tools, the comments saying "SAME builder tools" should be narrowed.

### 5. MCP stdio transport is real but not user-facing by default

Status: usable as an opt-in library; not wired into CLI/HTTP/default runtime.

Evidence it is real:

- `src/modules/mcp-model-loop/transports/stdio.ts:85-232` implements `createStdioTransport`.
- It spawns a child at `src/modules/mcp-model-loop/transports/stdio.ts:170`.
- It performs JSON-RPC initialize at `src/modules/mcp-model-loop/transports/stdio.ts:178-185`.
- It implements `tools/list` at `src/modules/mcp-model-loop/transports/stdio.ts:187-202`.
- It implements `tools/call` at `src/modules/mcp-model-loop/transports/stdio.ts:204-219`.
- It closes/kills the child at `src/modules/mcp-model-loop/transports/stdio.ts:221-230`.

Evidence it is not default/live:

- `src/modules/mcp-model-loop/loop.ts:56-70` defines `createMockTransport`.
- `src/modules/mcp-model-loop/loop.ts:101-105` defaults `transport` to `createMockTransport()`.
- `src/modules/mcp-model-loop/loop.ts:285-286` exports the process-wide `mcpModelLoop` with the mock transport.
- `src/modules/mcp-model-loop/index.ts:23-26` exports `createStdioTransport`, but the comment says the mock remains default and stdio must be wired via `createMcpModelLoop({ transport })`.

Conclusion: stdio transport is not a stub, but there is no current CLI route, HTTP route, or config loader that instantiates it for operators. The default MCP runtime remains a mock.

### 6. Context compressor is actually invoked in the builder loop

Status: wired and active.

Evidence:

- `src/modules/worker-model/builder.ts:55` imports `maybeCompress`.
- `src/modules/worker-model/builder.ts:809-823` calls `maybeCompress(...)` before each model invocation.
- `src/modules/worker-model/builder.ts:823` increments `compressions` when compression occurred.
- `src/modules/worker-model/context-manager.ts:116-163` implements the in-place compression.

Conclusion: the context compressor is not dead code; it is invoked on every builder loop round before `invokeModel`.

### 7. Subagent-spawning module is separate from `delegate_task`

Status: separate systems.

Evidence:

- Builder `delegate_task` imports `runDelegateTask` from `src/modules/worker-model/builder-tools/delegate.ts` at `src/modules/worker-model/builder.ts:46`.
- `delegate_task` dispatches `runDelegateTask(...)` directly at `src/modules/worker-model/builder.ts:652-663`.
- `runDelegateTask` implements its own bounded sub-loop in `src/modules/worker-model/builder-tools/delegate.ts:91-196`.
- The standalone subagent-spawning module is implemented in `src/modules/subagent-spawning/spawn.ts:61-180` and exports `subagentSpawner` at `src/modules/subagent-spawning/spawn.ts:179-180`.
- There is no import of `../subagent-spawning` in `src/modules/worker-model/builder-tools/delegate.ts`.

Conclusion: `delegate_task` does not use the `subagent-spawning` module. It is a separate in-builder sub-agent loop, not the identity-spawning/orchestrator-consuming module.

### 8. Auto-execute cognition dispatch maps to real commands, with one non-dispatch case

Status: mostly correct.

Evidence:

- `src/modules/cognition-layer/cli.ts:69-82` maps recommendations:
  - `batch-planner` -> `["batch", goal]`
  - `worker-model` -> `["build", goal]`
  - `agent-router` with `classify` -> `["classify", goal]`
  - `agent-router` otherwise -> `["ask", goal]`
  - `drift-prevention` -> `undefined`
- `src/cli/index.ts:40-48` dispatches only via the registered command registry.
- `src/cli/index.ts:151-154` runs module commands when the command exists.
- `src/modules/worker-model/cli.ts:193-200` registers `build`.
- `src/modules/batch-planner/cli.ts:138-145` registers `batch`.
- `src/modules/agent-router/cli.ts:130-143` registers `classify` and `ask`.
- `src/modules/cognition-layer/cli.ts:173-178` auto-dispatches only when a concrete argv exists and the decision is not `ask` or `reject`.

Conclusion: auto-execute cognition dispatches to the correct real commands for `worker-model`, `batch-planner`, and `agent-router`. `drift-prevention` deliberately has no concrete command, so cognition only reports that recommendation.

### 9. Import reachability vs operational dead surfaces

Status: no source file is import-unreachable from the service/CLI entrypoints, but several module surfaces have no live operator path.

Mechanical import reachability:

- `src/index.ts:13-16` imports the modules barrel before server start.
- `src/cli/index.ts:13-19` imports the modules barrel before CLI command dispatch.
- `src/modules/index.ts:25-49` side-effect-imports the current module set.
- A local resolver over non-test `src/**/*.ts` found all 165 source files reachable from `src/index.ts` plus `src/cli/index.ts` once `.js` specifiers are resolved to `.ts` files.

Operationally library-only or dormant:

- `dependency-install`: exported at `src/modules/dependency-install/index.ts:24-48`; implementation exists at `src/modules/dependency-install/install.ts:105-287`, but no CLI/HTTP caller invokes `dependencyInstall.run(...)`. Capability-recovery can recommend it, but does not dispatch it.
- `mcp-model-loop`: exported at `src/modules/mcp-model-loop/index.ts:23-52`; default loop uses mock transport at `src/modules/mcp-model-loop/loop.ts:101-105` and `src/modules/mcp-model-loop/loop.ts:285-286`; no CLI/HTTP entrypoint invokes `mcpModelLoop.run(...)`.
- `subagent-spawning`: exported at `src/modules/subagent-spawning/index.ts:21-38`; implementation exists at `src/modules/subagent-spawning/spawn.ts:61-180`; no current builder/chat delegate path uses it.
- `self-observation`: exported at `src/modules/self-observation/index.ts:24-43`; `selfObservation` is constructed at `src/modules/self-observation/observer.ts:139-140`, but nothing in production calls `selfObservation.start()` or `snapshot()`, and no route is mounted for it.

Conclusion: there are no completely orphaned source files by import graph, but several modules are library surfaces or dormant singletons rather than live features.

### 10. Stale comments/docs found

Status: documentation drift exists.

Examples:

- `MODULE_CENSUS.md:64-70` says the server exposes only `/health` and `/ready` and that no module routes are registered. This is stale: chat registers `POST /chat` at `src/modules/chat/routes.ts:29-40`, and the barrel imports chat at `src/modules/index.ts:39-40`.
- `src/modules/index.ts:18-20` says modules register routes/commands in a later barrel-wiring step and "none do so yet." This is stale: worker-model, batch-planner, agent-router, capability-recovery, trust, and kill-switch register CLI commands; chat registers an HTTP route.
- `src/modules/cognition-layer/index.ts:5-7` says cognition has no CLI command and needs no barrel entry. The "no named command" part is true, but it is now directly wired into `src/cli/index.ts:28` and `src/cli/index.ts:156-160` as the default CLI route.

Conclusion: code wiring has moved ahead of some module comments and `MODULE_CENSUS.md`. Treat comments that say "future wiring" skeptically unless verified against imports.

## Direct Answers to Audit Questions

1. Is cognition wired into the main flow or dead code?
   - Wired into CLI bare-goal fallback; not wired into HTTP or worker build roles. Not dead code.

2. Is drift-prevention used anywhere?
   - Yes, by cognition-layer and capability-recovery. It is advisory/read-only and does not actively prevent drift.

3. Are all 16 builder tools wired into builder loop and chat session?
   - Builder: yes, all 16 declared and dispatched. Chat: no, only 13 are present.

4. Is MCP stdio transport usable or a stub?
   - The stdio transport is real and usable if manually injected. The default MCP loop still uses a mock, and no operator entrypoint wires stdio.

5. Does `/chat` have all the same tools as builder?
   - No. It lacks `scout_detail`, `run_checks`, and `done`.

6. Is context compressor invoked in builder loop?
   - Yes, `maybeCompress` is called before each builder model invocation.

7. Are any modules present but never imported or used?
   - No non-test source files are import-unreachable from service/CLI entrypoints. Operationally dormant/library-only modules include `dependency-install`, `mcp-model-loop`, `subagent-spawning`, and `self-observation`.

8. Is subagent-spawning used by `delegate_task`?
   - No. `delegate_task` uses `worker-model/builder-tools/delegate.ts`, a separate simplified sub-loop.

9. Does auto-execute cognition dispatch to the right commands?
   - Yes for `build`, `batch`, `classify`, and `ask`; `drift-prevention` intentionally has no dispatchable command.

10. Any dead code, unused exports, or orphaned files?
    - No import-orphaned source files found. Main concerns are dormant library-only modules, `/chat` tool parity gap, default MCP mock transport, and stale comments/docs.

## Risk Ranking

High:

- `/chat` does not have the same tool surface as builder despite comments suggesting same-tool parity. Missing tools: `scout_detail`, `run_checks`, `done`.

Medium:

- MCP stdio is implemented but not connected to a user-facing path; operators get the mock unless custom code injects stdio.
- `delegate_task` and `subagent-spawning` are separate systems, which can surprise maintainers expecting the builder delegate to use the identity-spawning module.
- Drift-prevention is advisory only; name may imply stronger enforcement than exists.

Low:

- Stale comments and `MODULE_CENSUS.md` can mislead future work.
- Library-only modules are not necessarily bugs, but should be labeled clearly as library/dormant surfaces.

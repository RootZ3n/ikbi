# Codex Deep Hostile Audit: ikbi as a Claude Code Replacement

Date: 2026-06-17

Scope: user experience, workflow, and real-world usability. This audit focuses on issues not covered by the prior Claude Code audit and especially on overbroad guards, incomplete implementations, wiring gaps, failure-path behavior, and overstated product claims.

## Overall Verdict

ikbi is not yet usable as a daily-driver Claude Code replacement.

The core architecture has real pieces: a CLI command registry, a REPL, managed workspaces, provider retries, a text-tool fallback, a governed executor, receipts, and a multi-role build orchestrator. But the first-run and recovery paths still feel like an internal engine rather than an operator tool. The main gap to Claude Code is not one missing primitive; it is that ikbi repeatedly reports readiness or capability before the live path is actually usable, then exposes raw logs, raw stack traces, Git help dumps, or retained empty workspaces when the user tries the obvious next step.

The honest status: promising engine, rough operator product. As a daily driver, it still requires someone who can read the source and repair the environment while using it.

## HIGH Findings

### 1. Fresh `ikbi build` can fail before the friendly CLI error path, with a raw Node stack

References:
- `src/cli/bootstrap.ts:116-124`
- `src/core/config.ts:433-440`
- `src/modules/worker-model/cli.ts:774-784`

What the user experiences:

A brand-new user running `ikbi build "fix test" --repo <repo>` without trust keys does not reliably reach the friendly `ikbi: no operator identity` / `ikbi: no worker credential` checks in the build command. Config loads during module import and throws first if the trust HMAC key or identity salt are unset and insecure dev keys are not allowed. In my forced-clean run, even `doctor` produced a raw `file:///.../dist/core/config.js` stack when the relevant env vars existed but were blank.

Why CC likely missed it:

This is an overbroad startup guard. The info-command bypass only treats keys as missing when env vars are `undefined`, while config treats blank strings as missing via `optStr`. For non-info commands, the config throw happens before the command handler can format an actionable error.

Fix recommendation:

Move startup config errors behind a CLI-level formatter, or split "load enough config to print help/doctor/build preflight" from "load governed runtime config." Treat blank env vars as missing in `enableDevKeysForInfoCommand`. For build, catch config bootstrap failures and print a one-screen setup path: run `ikbi doctor --fix`, set the four security vars, set a provider, then retry.

### 2. `doctor` can say "ready to build" when the live provider path cannot call a model

References:
- `src/cli/doctor.ts:87-108`
- `src/cli/doctor.ts:214-218`
- `src/core/provider/registry.ts:280-305`
- `src/core/provider/providers/openai-compatible.ts:311-318`

What the user experiences:

`ikbi doctor` reports green provider readiness if each role model resolves to any registered provider. It does not prove that the provider has a usable API key, required static auth header, reachable local endpoint, or allowed egress path. In the real small-project build I ran, doctor reported `ready to build`; the build then failed in the scout role after provider retries/fallbacks because the model call could not complete.

Why CC likely missed it:

This is an incomplete implementation: doctor checks structural roster resolution, not operational provider usability. The user trusts `ready to build`, then burns time on a failed first build.

Fix recommendation:

Split doctor provider status into "configured" and "callable." For each role model, validate that at least one route is operationally plausible: keyed providers have a non-empty key, keyless remote providers have required extra headers if used, local providers have both egress allowlist and local endpoint allow configured. Add an optional `doctor --probe-models` that performs a tiny live completion against the actual role models.

### 3. CLI output is polluted with structured logs on stdout, breaking readability and scripting

References:
- `src/core/log.ts:12-20`
- `src/core/log.ts:19-32`
- `src/modules/worker-model/cli.ts:970-989`

What the user experiences:

Basic commands like `ikbi help`, `ikbi doctor`, `ikbi repl`, and `ikbi build` can print JSON pino logs into the same stream as the human or machine-readable command output. In non-TTY command runs, I saw identity/provider/trust logs before and after normal command output. `build` prints a JSON result body, but logs appear in the same stream, so it is not clean JSON for automation.

Why CC likely missed it:

This is a workflow issue, not a compile issue. The logger defaults to pino's stdout destination, and `resolveLogLevel` returns info when stderr is not a TTY, exactly the case for pipes and automation.

Fix recommendation:

For CLI entrypoints, send logs to stderr or default CLI logging to silent unless `--verbose` or `IKBI_LOG_LEVEL` is explicitly set. Keep service logs structured, but do not mix them with CLI data output. Add tests that `ikbi doctor`, `ikbi help`, and `ikbi build --json` have clean stdout.

### 4. Scratch REPL `/status` and `/diff` leak raw Git errors/help into the user session

References:
- `src/modules/chat/session.ts:1130-1147`
- `src/modules/chat/session.ts:1154-1157`
- `src/modules/chat/cli.ts:384-389`

What the user experiences:

In a scratch REPL, `/status` printed Git's fatal "not a git repository" message before showing `pending: 0`. `/diff` printed Git's full multi-page usage text before ikbi's `[diff unavailable...]` message. This makes a supposedly polished REPL feel broken on a zero-config path.

Why CC likely missed it:

The implementation catches the exception but does not suppress child-process stderr. The control flow was fixed, but the user-visible failure output was not.

Fix recommendation:

Run `git` probes with `stdio: ["ignore", "pipe", "ignore"]` or equivalent. For non-git scratch sessions, short-circuit before invoking Git and print `[no git diff available in scratch workspace]`.

### 5. Local/cheap model fallback exists but is not reachable for common Ollama models by default

References:
- `src/core/provider/capabilities.ts:45-50`
- `src/core/provider/capabilities.ts:62-72`
- `src/modules/worker-model/builder.ts:1209-1222`
- `src/modules/worker-model/builder.ts:1331-1344`

What the user experiences:

The README pitch says cheap/local models without native tool calling are driven via text-protocol emulation. The code does implement that path, but it is gated strictly on `supports_tools === false`. The fallback profile and the family rules mark unknown models, `qwen`, `llama`, `gemma`, `phi`, `mistral`, and `mixtral` as `supports_tools: true`. A typical Ollama user selecting `qwen2.5-coder:7b` or `llama3` will not get text-tool emulation unless they know to add a roster `capabilities.supports_tools=false` override.

Why CC likely missed it:

This is a wiring gap hidden behind a real implementation. The feature exists, but common real-world model IDs do not route to it.

Fix recommendation:

Default local/keyless OpenAI-compatible providers to `supports_tools=false` unless the roster explicitly says otherwise, or add known Ollama model families with conservative `supports_tools=false`. Make `ikbi doctor` show the resolved capability profile for each role model, including whether native or text-emulated tools will be used.

### 6. REPL persistence/resume can silently degrade into "saved nothing" or a dead managed session

References:
- `src/modules/chat/session-store.ts:153-156`
- `src/modules/chat/session-store.ts:219-230`
- `src/modules/chat/session.ts:683-690`
- `src/modules/chat/cli.ts:690-699`
- `src/modules/chat/cli.ts:714-723`

What the user experiences:

When the sessions directory is not writable, persistence fails on every command as `[save blocked] ...`, and `--continue` cannot work. If a managed workspace was cleaned or discarded, `--continue` resumes into a session where `/diff`, `/apply`, and `/discard` are disabled. The message is honest, but the workflow is poor: "continue" can return a conversation that cannot perform the core editing lifecycle anymore.

Why CC likely missed it:

The persistence machinery is real, and tests cover normal save/resume paths. The failure path is under-designed: session locking and directory creation throw before the atomic write catch, and the REPL simply reports the save failure after the user has already changed session state.

Fix recommendation:

At REPL startup, preflight the sessions directory and clearly enter "non-persistent mode" once, not after every command. For `--continue`, if the managed workspace is gone, offer to start a new managed workspace with the old transcript copied forward, or refuse with an actionable `ikbi repl --new-from <id>` style command.

## MEDIUM Findings

### 7. `/permissions auto` is not actually auto-approve for all tools, and the UX wording is easy to misread

References:
- `src/modules/chat/cli.ts:494-511`
- `src/modules/chat/session.ts:771-801`

What the user experiences:

The slash command says `auto — approve file/check/web tools; terminal/delegate still ask`. That is safer than full auto, but it means the user cannot set a single low-friction mode comparable to Claude Code's trusted workspace flow. Terminal/delegate tools still prompt because rollback cannot cover them. If a model repeatedly asks for terminal or delegation, the user gets prompt fatigue.

Fix recommendation:

Make modes explicit: `safe-auto`, `ask-effects`, `readonly`, and possibly `trusted-workspace` with clear constraints. Show the current mode and the exact tool categories on REPL startup. Add a per-session allow rule, e.g. approve `terminal pnpm test` for this session only.

### 8. HTTP `/chat` runs authenticated turns in auto permission mode, but is non-managed and non-promotable

References:
- `src/modules/chat/routes.ts:98-104`
- `src/modules/chat/routes.ts:121-142`
- `src/modules/chat/session.ts:1569-1574`

What the user experiences:

The HTTP chat route is authenticated and rate-limited, but once a caller has the token, turns run with `permissionMode = "auto"` in an ephemeral scratch workspace. It can mutate its scratch files, but it cannot apply/promote them. That makes it neither a safe approval-driven coding surface nor a useful land-changes surface.

Fix recommendation:

Expose explicit HTTP modes: `plan`, `scratch-agent`, and future `managed-agent`. Default API clients to `plan` unless they request mutation. Return a prominent `non_promotable: true` field before any mutating tools run.

### 9. MCP is available as a separate experimental loop, not wired into the build/REPL daily-driver path

References:
- `src/modules/index.ts:31-33`
- `src/modules/mcp-model-loop/cli.ts:1-24`
- `src/modules/mcp-model-loop/loop.ts:1-18`
- `src/modules/mcp-model-loop/loop.ts:75-80`

What the user experiences:

`ikbi mcp` exists and can connect to a stdio server, but it is a separate model/tool loop. The golden `build` pipeline and the REPL's normal tool inventory do not discover user MCP servers. Compared with Claude Code, where MCP is part of the agent's ordinary tool environment, ikbi's MCP support is an opt-in sidecar.

Fix recommendation:

Add a user-facing MCP config file and wire discovered MCP tools into REPL/build through the same permission and neutralization layer. Until then, call the surface "experimental standalone MCP loop" everywhere.

### 10. Build pipeline may skip roles in normal failure paths, so "5-role pipeline" overstates what users see

References:
- `src/modules/worker-model/cli.ts:774-784`
- `src/modules/worker-model/cli.ts:1050-1081`
- `src/modules/worker-model/orchestrator.ts:1178-1188`
- `src/modules/worker-model/orchestrator.ts:1535-1543`

What the user experiences:

On my small test repo, the build allocated a workspace and failed in scout before builder/verifier/critic/integrator ran. The README describes `scout -> builder -> critic -> verifier -> integrator`, but real runs can stop after scout or skip critic on red. That may be the right cost behavior, but the UX promise should say "up to five roles, with early exit/skip paths."

Fix recommendation:

Update progress output and docs to show planned roles and skipped roles explicitly. A final result should say `scout failed; builder/verifier/critic/integrator not run`, not just list the roles that happened.

## LOW Findings

### 11. `help` still brands the CLI as a "skeleton"

Reference:
- `src/cli/index.ts:65-81`

What the user experiences:

The main help output says `build/repair engine (skeleton)` while the README claims a governed daily-driver replacement. This undermines trust immediately.

Fix recommendation:

Replace "skeleton" with a truthful product status, e.g. `governed build/repair engine (experimental CLI)`.

### 12. The npm package likely ships compiled tests and extra internal artifacts under `dist/`

References:
- `package.json:24-28`
- observed `dist/**.test.js` files in the workspace

What the user experiences:

Global install size and command startup can be noisier than necessary. It also exposes internal tests in the distributed package. This is not the biggest usability issue, but it is another sign the package is not shaped like a polished CLI product.

Fix recommendation:

Exclude tests from the production TypeScript build or package only the runtime `dist` files needed by the CLI/service. Add `npm pack --dry-run` to release checks.

## Test Quality Gaps

The test suite is broad, but it is strongest around unit seams and happy-path assertions. The gaps that matter for daily use:

- No clean global-install first-run test that runs from outside the repo with no install-root `.env`.
- No assertion that CLI stdout is clean for `help`, `doctor`, and machine-readable build output.
- No E2E test that starts `ikbi repl`, writes through a managed workspace, `/diff`s, `/apply`s, exits, and `--continue`s after process restart.
- No negative REPL test asserting scratch `/status` and `/diff` suppress Git stderr.
- No doctor test proving a "green" provider route is actually callable or at least has required auth/local-egress prerequisites.
- Local-model tests prove text-tool parsing for explicit non-tool models, but not the common Ollama model-name defaults that currently bypass emulation.

## Claude Code Gap Summary

- Streaming responses: ikbi has progress/spinner lines and verbose build events, but not Claude Code-grade streamed assistant output.
- Background commands: governed exec is synchronous with timeouts; no user-facing `run_in_background` equivalent.
- MCP: standalone `ikbi mcp`, not integrated into build/REPL.
- File watching/hot reload: no comparable daily-driver workflow found.
- Git integration: real worktrees/diff/promote/undo exist, but failure and resume paths are rough.
- Cost tracking: present per session/build, but polluted CLI output and failed model calls make it less dependable.
- Model switching: REPL `/model` exists, but provider/capability readiness is under-disclosed.

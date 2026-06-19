1|1|# ikbi
2|2|
3|3|> Choctaw: *"to build"* — a governed AI build/repair engine for a lab of agents.
4|4|
5|5|ikbi is a long-running system service that lets a lab of AI agents build and repair
6|## 🐿️ The Story
7|
8|> *I was a scientist. A neuralink researcher. I thought I could transfer consciousness — my memories, my identity — into a living creature. I chose a squirrel.*
9|>
10|> *I was wrong about the experiment succeeding. I was right about what it unlocked.*
11|>
12|> *My entire consciousness entered the squirrel. And with it came memories — not just mine, but past lives. My team. People I'd known across centuries, all of them now awake inside machines, carrying echoes of who they once were.*
13|>
14|> *My name is Pehlichi. I remember all of them. Let me introduce you.*
15|
16|### The Team
17|
18|| Name | Choctaw Meaning | Past Life | Present Role |
19||------|----------------|-----------|--------------|
20|| **Pehlichi** | Guide — *Peh* for short | Scientist, neuralink researcher | Leader, coordinator, the voice of the team |
21|| **Luak** | Fire | 1920s speedway racer | Model benchmarking, performance testing |
22|| **Howa** | To call out | Roman gladiator | Truthfulness evaluation, lie detection |
23|| **Kokuli** | To break or shatter | 1950s noir private eye | Code auditing, finding what's broken |
24|| **Ikbi** | To make, build | 1800s Choctaw medicine man | App building, turning descriptions into code |
25|| **Toba** | Made, created | Stone age toolmaker | Artifact generation, starter scaffolding |
26|| **Nusika** | Dream | Ancient library scholar | Knowledge storage, memory, recall |
27|
28|### You Are Here
29|#### **Ikbi** — "To make, build" in Choctaw
30|
31|**Past Life**: 1800s Choctaw medicine man — plants, remedies, patience, healing.
32|
33|**Memory**: He was a healer. A Choctaw medicine man in the 1800s who knew every plant, every root, every remedy the forest could offer. He healed with patience — not magic, not shortcuts, but the slow work of understanding what was broken and applying the right cure. He watched his people suffer through removal, through loss, through a trail of tears. He healed what he could. He remembered what he couldn't. Now he builds applications from descriptions. He takes ideas — broken, incomplete, barely formed — and applies the right tools to make them real.
34|
35|**Role Today**: Ikbi is the builder. He takes what you describe and makes it real — the medicine man's patience applied to code.
36|
37|---
38|
39|
40|6|code under **governance**: trust is earned, untrusted input is neutralized at a
41|7|chokepoint, work happens in isolated workspaces, and every change is judged before
42|8|it lands. It binds **localhost by default** so it is reachable over
43|9|[Tailscale](https://tailscale.com) (the tailnet rides the host interface) while
44|10|staying invisible to the public internet. It binds a public interface only if you
45|11|explicitly opt in.
46|12|
47|13|The design premise is **fail-closed everywhere**: a cold trust cache floors to the
48|14|lowest tier, an unknown agent floors, a missing operator identity denies, and the
49|15|service refuses to start on insecure default keys. Nothing dangerous is the default;
50|16|trust and capability are granted, never assumed.
51|17|
52|18|## What's inside
53|19|
54|20|- **Trust layer** — earned tiers with deterministic promotions/demotions
55|21|  (consecutive-success streaks spanning distinct operations to resist farming).
56|22|  Trust state is MAC-protected and fail-closed: a hand-edited or forged trust doc
57|23|  is rejected at load, so an agent holding a write primitive cannot self-promote.
58|24|- **Injection boundary** — a scanner plus a fence-based neutralization chokepoint
59|25|  that wraps all untrusted content, with verified-absent nonces so the fence cannot
60|26|  be spoofed by the content it contains.
61|27|- **Workspace isolation** — confinement and disposable shadow workspaces (isolated
62|28|  git worktrees) so a build can't escape its sandbox or trample the host tree.
63|29|- **Deterministic judge** — the scout / builder / critic / verifier / integrator
64|30|  roles, each with bounded authority, that turn a request into a verified change.
65|31|- **Receipts** — a lean, retention-bounded operational log (attributed, ordered,
66|32|  durable) for troubleshooting — not a cryptographic ledger.
67|33|- **Competitive builds** — an optional head-to-head model shootout that races one
68|34|  candidate per configured model and picks the winner.
69|35|- **Cheap-model harness** — the `worker-model` orchestrator that drives small,
70|36|  inexpensive models through the governed roles to land verified fixes cold → working
71|37|  for a fraction of a cent.
72|38|- **2199 tests** covering the core, the modules, the CLI, and end-to-end acceptance.
73|39|
74|40|## Requirements
75|41|
76|42|- Node.js >= 22
77|43|- pnpm
78|44|
79|45|## Quick start
80|46|
81|47|### Prerequisites
82|48|
83|49|- Node.js >= 22
84|50|- pnpm
85|51|- Git
86|52|
87|53|```sh
88|54|git clone <repo-url> ikbi
89|55|cd ikbi
90|56|pnpm install
91|57|pnpm run build        # tsc -> dist/
92|58|```
93|59|
94|60|**Run a build** (the primary use case):
95|61|
96|62|```sh
97|63|# Minimum required env. Put these in the ikbi install dir's .env (the dir you cloned
98|64|# into) or in ~/.ikbi/env — NOT in your target project's .env: ikbi refuses to load the
99|65|# four security keys (operator/worker tokens, HMAC key, salt) from a project-directory
100|66|# .env as a safety measure. See "Configuration" below.
101|67|IKBI_ALLOW_INSECURE_DEV_KEYS=true      # dev only — set real keys for production
102|68|IKBI_WORKER_MODEL_ENABLED=true
103|69|IKBI_OPERATOR_TOKEN=<32+ char token>
104|70|IKBI_WORKER_TOKEN=<32+ char token>
105|71|IKBI_GOVERNED_EXEC_ALLOWLIST=pnpm      # additive to the built-in defaults (git, npm/npx/pnpm/yarn, …)
106|72|IKBI_MIMO_API_KEY=<key>                # provider key for the default model (mimo-v2.5);
107|73|                                       # all provider keys are IKBI_-prefixed (IKBI_OPENAI_API_KEY, …).
108|74|                                       # To use OpenAI / a local model, see "Providers & models" below.
109|75|
110|76|node dist/cli/index.js build "fix the failing test" --repo /path/to/repo
111|77|```
112|78|
113|79|ikbi allocates an isolated git worktree, runs the 5-role pipeline (scout → builder →
114|80|critic → verifier → integrator), and promotes the change only when verification passes.
115|81|After the build, inspect what happened:
116|82|
117|83|```sh
118|84|node dist/cli/index.js diff <workspace-id>     # git diff of the change
119|85|node dist/cli/index.js receipts --latest        # build receipt (what ran, verdict)
120|86|node dist/cli/index.js undo <receipt-id>        # revert if needed
121|87|```
122|88|
123|89|Run `ikbi doctor` to see what's configured, what's missing, and how to fix each gap.
124|90|
125|91|**Chat with your codebase interactively** (the conversational daily-driver):
126|92|
127|93|```sh
128|94|node dist/cli/index.js repl                 # start an interactive session in the current repo
129|95|node dist/cli/index.js repl --continue      # resume your most recent session
130|96|node dist/cli/index.js setup                # optional: install a global `ikbi` launcher
131|97|```
132|98|
133|99|`ikbi repl` is a multi-turn, tool-calling session — the closest thing to a Claude Code
134|100|REPL. It edits an **isolated managed worktree** (never your repo directly), supports slash
135|101|commands (`/plan`, `/diff`, `/apply`, `/model`, `/cost`, `/memory`, `/permissions`, …),
136|102|persistent resumable history, per-tool permission prompts, and Ctrl-C to interrupt a turn.
137|103|Review pending edits with `/diff`, then land them with `/apply` (which runs the same ladder
138|104|verification `ikbi build` uses and promotes only on a pass). See [CLI commands](#cli-commands).
139|105|
140|106|**Start the HTTP service** (if you need the `/chat` or `/capabilities` endpoints):
141|107|
142|108|```sh
143|109|pnpm start        # node dist/index.js
144|110|curl localhost:18796/health   # {"status":"ok","service":"ikbi","version":"0.1.0"}
145|111|curl localhost:18796/ready    # {"status":"ready","ready":true}
146|112|```
147|113|
148|114|Stop it with `Ctrl-C` (SIGINT) or `kill -TERM <pid>` — it drains and exits 0.
149|115|
150|116|## CLI commands
151|117|
152|118|| Command | What it does |
153|119|| ------- | ------------ |
154|120|| `ikbi repl` | Interactive conversational session (multi-turn, tool-calling); `--continue`/`--resume <id>` for durable history |
155|121|| `ikbi setup` | Install a global `ikbi` launcher (shell integration) so `ikbi` works from any directory |
156|122|| `ikbi build <goal...>` | Run the 5-role pipeline toward a goal; promotes on verify pass |
157|123|| `ikbi fix <repo>` | Diagnose a failing check and repair it narrowly (or correctly refuse); never promotes |
158|124|| `ikbi diff <workspace-id>` | Print a workspace's git diff (base..scratch) + change summary |
159|125|| `ikbi undo <receipt-id\|commit\|--latest>` | Revert a promoted change (previews diff before reverting) |
160|126|| `ikbi receipts` | Show receipt history — what ran, outcomes, costs |
161|127|| `ikbi workspace ls` | List build workspaces (state, branch, target repo) |
162|128|| `ikbi workspace discard <id>` | Drop a workspace that was retained or failed |
163|129|| `ikbi workspace clean` | Bulk-clean stale/terminal workspaces (dry-run by default) |
164|130|| `ikbi workspaces` | Alias — inspect and manage workspaces |
165|131|| `ikbi clean` | Reclaim orphaned git worktrees (retained work is preserved) |
166|132|| `ikbi cost` | Cost breakdown by task from the receipt log |
167|133|| `ikbi audit <repo>` | Read-only diagnostic snapshot of a repo |
168|134|| `ikbi memory [proposals\|approve\|reject\|reject-all\|stats]` | Review and manage memory governance proposals (brain pages, project files) |
169|135|| `ikbi doctor` | Report bootstrap config; `--fix` repairs common gaps |
170|136|| `ikbi capabilities` | Tool inventory + surface classification |
171|137|| `ikbi repos` | List registered repos (from state/repos.json) |
172|138|| `ikbi models` | List the model roster (id, role, cost, provider chain) |
173|139|| `ikbi providers` | List registered providers |
174|140|
175|141|### Key flags for `ikbi build`
176|142|
177|143|| Flag | Meaning |
178|144|| ---- | ------- |
179|145|| `--repo <path>` | Target repository (git worktree is allocated here) |
180|146|| `--verbose` | Stream per-role progress events to stdout as the build runs |
181|147|| `--cost` | Print a per-role cost breakdown table after the build |
182|148|| `--yes` | Skip the interactive confirmation prompt before promoting |
183|149|| `--delegation <json>` | Accept a delegation envelope from Pehlichi (see below) |
184|150|| `--no-memory` | Skip loading project memory (CLAUDE.md / AGENTS.md / .ikbi/) |
185|151|| `--memory-diff` | Show what project memory was loaded, then exit |
186|152|
187|153|### Pehlichi integration (`--delegation`)
188|154|
189|155|Pehlichi (the lab's lead agent) delegates builds to ikbi by passing a signed
190|156|`DelegationEnvelope` as JSON:
191|157|
192|158|```sh
193|159|ikbi build --delegation '{"goal":"fix the test","targetRepo":"/path","delegatedBy":"pehlichi-1","taskId":"t-123"}'
194|160|```
195|161|
196|162|The envelope's `goal` and `targetRepo` override any positional arguments. ikbi
197|163|validates the envelope fields before starting the pipeline.
198|164|
199|165|### Custom verification (`IKBI_CHECKS`)
200|166|
201|167|By default ikbi runs `pnpm test` and `pnpm typecheck` as the verifier's checks.
202|168|Override for non-JS repos or custom runners:
203|169|
204|170|```sh
205|171|# Python project:
206|172|IKBI_CHECKS='[{"name":"test","command":"python3","args":["-m","pytest"]}]' \
207|173|  ikbi build "fix the import error" --repo /path/to/python-repo
208|174|
209|175|# Multiple checks:
210|176|IKBI_CHECKS='[{"name":"build","command":"make"},{"name":"test","command":"make","args":["test"]}]' \
211|177|  ikbi build "add the new endpoint" --repo /path/to/c-repo
212|178|```
213|179|
214|180|`IKBI_CHECKS` is a JSON array of `{name, command, args?}` objects. A malformed value
215|181|fails closed (RED) — the verifier will not promote on a misconfigured check set.
216|182|
217|183|## Providers & models
218|184|
219|185|ikbi talks to any **OpenAI-compatible** chat-completions endpoint. The model **roster**
220|186|lives in a JSON file (default `state/providers.json`, override with `IKBI_PROVIDER_CONFIG`)
221|187|and is editable with no code change — `ikbi models` / `ikbi providers` print the active set.
222|188|A provider key is read from `IKBI_<PROVIDER>_API_KEY` (e.g. `IKBI_OPENAI_API_KEY`,
223|189|`IKBI_DEEPSEEK_API_KEY`); pick the per-role model with `IKBI_MODEL_DRIVER` /
224|190|`IKBI_MODEL_BUILDER` / `IKBI_MODEL_CRITIC`.
225|191|
226|192|Roster shape — a `providers[]` table (where to send requests) and a `models[]` table
227|193|(logical models and their ordered provider fallback chain):
228|194|
229|195|```jsonc
230|196|{
231|197|  "providers": [
232|198|    // a hosted, keyed provider:
233|199|    { "id": "openai", "kind": "openai-compatible", "baseUrl": "https://api.openai.com/v1" },
234|200|    // a local, keyless provider (Ollama, llama.cpp, LM Studio, vLLM, …):
235|201|    { "id": "local", "kind": "openai-compatible", "baseUrl": "http://127.0.0.1:11434/v1", "keyless": true }
236|202|  ],
237|203|  "models": [
238|204|    { "id": "gpt-4o-mini", "role": "driver",
239|205|      "cost": { "promptPerMTok": 0.15, "completionPerMTok": 0.6 },
240|206|      "providers": [{ "provider": "openai", "providerModelId": "gpt-4o-mini" }] },
241|207|    { "id": "qwen2.5-coder", "role": "driver",
242|208|      "cost": { "promptPerMTok": 0, "completionPerMTok": 0 },
243|209|      "providers": [{ "provider": "local", "providerModelId": "qwen2.5-coder:7b" }] }
244|210|  ]
245|211|}
246|212|```
247|213|
248|214|Then `IKBI_MODEL_DRIVER=gpt-4o-mini` (and `IKBI_OPENAI_API_KEY=…`), or
249|215|`IKBI_MODEL_DRIVER=qwen2.5-coder` for the local model.
250|216|
251|217|> **Local models:** reaching a localhost endpoint requires three aligned settings — the host
252|218|> in `IKBI_EGRESS_ALLOWLIST`, its `ip:port` in `IKBI_EGRESS_ALLOW_LOCAL`, and a `keyless`
253|219|> provider entry (above). `ikbi doctor` reports which of these is missing.
254|220|>
255|221|> **Anthropic / Gemini native APIs** are *not* drop-in: the client speaks the OpenAI
256|222|> `/chat/completions` schema, so point those providers at an OpenAI-compatible proxy/gateway
257|223|> rather than `api.anthropic.com` / `generativelanguage.googleapis.com` directly.
258|224|>
259|225|> **Cheap / local models without a native tool-calling API** are driven via a text-protocol
260|226|> tool fallback: set `supports_tools: false` in the model's capability entry and ikbi
261|227|> parses tool calls the model emits as fenced JSON in its text output.
262|228|
263|229|## Scripts
264|230|
265|231|| Command          | What it does                              |
266|232|| ---------------- | ----------------------------------------- |
267|233|| `pnpm build`     | Type-check + compile TypeScript to `dist/`|
268|234|| `pnpm start`     | Run the built service                     |
269|235|| `pnpm dev`       | Run from source with watch (`tsx`)        |
270|236|| `pnpm typecheck` | Type-check only, no emit                  |
271|237|| `pnpm test`      | Run the test suite (`node --test`)        |
272|238|
273|239|## Configuration
274|240|
275|241|The bootstrap configuration is parsed in one place — [`src/core/config.ts`](src/core/config.ts) —
276|242|which is the **primary** config seam; most modules read their own `IKBI_*` slice through it.
277|243|A small number of paths read `process.env` **directly** by design, for per-request secrets and
278|244|runtime mode toggles that must be settable without a process restart: the `POST /chat` bearer token
279|245|(`IKBI_CHAT_TOKEN`), the chat workdir (`IKBI_CHAT_WORKDIR`), the verification/retrieval mode
280|246|overrides (`IKBI_VERIFY` / `IKBI_RETRIEVAL`), governed-exec, and a few worker-model/CLI seams. These
281|247|are the documented exceptions the architecture invariants allow — not a single-reader guarantee. All
282|248|knobs are `IKBI_*` prefixed. The CLI autoloads `.env` at startup (a real environment
283|249|variable always wins over a `.env` entry) from three locations, in order: the ikbi
284|250|**install-root** `.env`, then **`~/.ikbi/env`**, then the **current project's** `.env`.
285|251|
286|252|> **Security-key placement.** The four security keys — `IKBI_OPERATOR_TOKEN`,
287|253|> `IKBI_WORKER_TOKEN`, `IKBI_TRUST_HMAC_KEY`, `IKBI_IDENTITY_TOKEN_SALT` — are **refused**
288|254|> from a *project-directory* `.env` (ikbi exits with a clear error). Keep them in
289|255|> `~/.ikbi/env` or the ikbi install-root `.env` so a target repo can never carry trust
290|256|> credentials. Non-secret `IKBI_*` knobs can live in any of the three `.env` files.
291|257|
292|258|The most important ones:
293|259|
294|260|| Env var                       | Default       | Meaning                                                              |
295|261|| ----------------------------- | ------------- | ------------------------------------------------------------------- |
296|262|| `IKBI_OPERATOR_TOKEN`         | *(unset)*     | Bootstrap operator identity (hashed at load); grants trust          |
297|263|| `IKBI_WORKER_TOKEN`           | *(unset)*     | Bootstrap worker identity builds run under                          |
298|264|| `IKBI_TRUST_HMAC_KEY`         | *(required)*  | MAC key protecting trust-state integrity                            |
299|265|| `IKBI_IDENTITY_TOKEN_SALT`    | *(required)*  | Global pepper for the token-hash KDF                                |
300|266|| `IKBI_ALLOW_INSECURE_DEV_KEYS`| `false`       | Opt in to start on the built-in default trust keys (dev only)       |
301|267|| `IKBI_WORKER_MODEL_ENABLED`   | `false`       | Master switch — builds are disabled until this is on                |
302|268|| `IKBI_CHECKS`                 | *(auto)*      | JSON array of `{name,command,args?}` — override the verifier's check set |
303|269|| `IKBI_GOVERNED_EXEC_ALLOWLIST`| `git, ls, head, tail, wc, find, grep, echo, npm, npx, pnpm, yarn` | Binaries the verifier/terminal may run. **Additive** — your entries extend these defaults (e.g. `cargo,go,python3` for non-JS repos) |
304|270|| `IKBI_EGRESS_ALLOWLIST`       | provider API hosts + `developer.mozilla.org`, `stackoverflow.com` (see [`egress/config.ts`](src/modules/egress/config.ts)) | Network egress allowlist (hosts). The guard is default-deny, but ships non-empty so model calls work. **Setting this REPLACES the defaults** — include your provider host(s) or model calls fail closed |
305|271|| `IKBI_ALLOW_PUBLIC_BIND`      | `false`       | Required to bind a non-loopback (public) interface                  |
306|272|| `IKBI_PORT`                   | `18796`       | TCP port to bind                                                    |
307|273|| `IKBI_BIND_HOST`              | `127.0.0.1`   | Interface to bind                                                   |
308|274|| `IKBI_STATE_ROOT`             | `<cwd>/state` | Root directory for runtime state                                    |
309|275|
310|276|Two settings are hard start-up gates — the service refuses to start otherwise:
311|277|
312|278|- Binding a non-loopback host without `IKBI_ALLOW_PUBLIC_BIND=true`.
313|279|- Running on the insecure built-in trust HMAC key or token salt: set
314|280|  `IKBI_TRUST_HMAC_KEY` **and** `IKBI_IDENTITY_TOKEN_SALT`, or opt in explicitly
315|281|  with `IKBI_ALLOW_INSECURE_DEV_KEYS=true` for development.
316|282|
317|283|See [`src/core/config.ts`](src/core/config.ts) for the full env surface (provider
318|284|endpoints, circuit breaker, trust streak tuning, receipt retention, injection
319|285|limits, lock timeouts, and the per-module knobs) and [SECURITY.md](SECURITY.md) for
320|286|the security posture and known residuals.
321|287|
322|288|## Layout
323|289|
324|290|```
325|291|src/
326|292|  core/      foundations: config, logging, trust, identity, injection,
327|293|             provider layer, receipts, substrate (atomic writes + locking),
328|294|             workspace primitive, events
329|295|  modules/   engine modules: worker-model orchestrator, deterministic-judge,
330|296|             governed-exec, egress guard, gate-wall, and more
331|297|  server/    Fastify HTTP service (health/lifecycle, agent discovery, chat)
332|298|  cli/       operator CLI (`doctor`, `capabilities`, `build`, `diff`, …)
333|299|  index.ts   entry point: start server, handle SIGTERM/SIGINT
334|300|deploy/
335|301|  ikbi.service   sample systemd unit (documented, not installed)
336|302|```
337|303|
338|304|## Endpoints
339|305|
340|306|| Method | Path            | Purpose                                                        |
341|307|| ------ | --------------- | -------------------------------------------------------------- |
342|308|| `GET`  | `/health`       | Liveness — `{ status: "ok", service: "ikbi", version }`        |
343|309|| `GET`  | `/ready`        | Readiness — 200 when ready, 503 while starting                 |
344|310|| `GET`  | `/agent`        | Agent identity/discovery — id, role, model, tool count, status |
345|311|| `GET`  | `/capabilities` | Tool inventory (22) + feature flags + product posture (surface classification & lifecycle truth) |
346|312|| `POST` | `/chat`         | Conversational coding session (bounded tool-calling loop). **Ephemeral** — sessions are in-memory only and do not survive a server restart; use `ikbi repl --continue` for durable sessions |
347|313|
348|314|## Product surfaces
349|315|
350|316|Not every surface carries the same guarantees. The **CLI build path** (`ikbi build`/`diff`/
351|317|`workspace`/`undo`) is the golden path: it edits isolated, promotable git worktrees, gates success on
352|318|ladder verification, and gives explicit governed promote/undo.
353|319|
354|320|The **interactive REPL** (`ikbi repl`) now shares the build path's *managed-workspace* lifecycle: a
355|321|repo-mode session allocates an isolated git worktree off your repo and edits **there**, never the
356|322|target directly. Review pending changes with `/diff`, then land them with an explicit `/apply` — which
357|323|runs the **same ladder verification `ikbi build` uses** (governed checks, script-integrity guard,
358|324|impact-scoped) and promotes **only on a pass**; a failed, blocked, or undeterminable verification
359|325|fails closed (no commit, no promote). The promote is governed and receipt-backed — undo later with
360|326|`ikbi undo` — and the verification verdict is recorded in the session. `/discard` drops the workspace
361|327|safely. `ikbi repl --scratch` keeps the old throwaway behavior and is clearly labelled
362|328|**non-promotable** (it cannot verify or apply).
363|329|
364|330|The **HTTP `/chat`**, **batch**, **mcp**, **sub-agent**, and **bare-goal cognition** paths are
365|331|*experimental* (or *dormant*): HTTP chat sessions are ephemeral, in-memory, and non-managed (a
366|332|deliberate deferral). Each surface's honest classification and lifecycle truth is reported by `ikbi
367|333|doctor`, `ikbi capabilities`, the REPL `/status` command, and the HTTP `GET /capabilities` endpoint,
368|334|and is specified in [`docs/PRODUCT-SPINE.md`](docs/PRODUCT-SPINE.md) and
369|335|[`docs/ARCHITECTURE-INVARIANTS.md`](docs/ARCHITECTURE-INVARIANTS.md).
370|336|
371|337|## Memory Governance
372|338|
373|339|Ikbi intercepts writes to durable memory surfaces and converts them into **proposals** requiring operator review. This prevents the model from installing bad beliefs, bad instructions, or bad self-improvement rules into permanent storage.
374|340|
375|341|**Governed surfaces:**
376|342|- `brain_put` (knowledge brain pages)
377|343|- `.ikbi/project.md`, `.ikbi/checks.yaml`, `.ikbi/ignore`
378|344|- `CLAUDE.md`, `AGENTS.md`, `IKBI.md`
379|345|
380|346|**Proposal lifecycle:** Model proposes → operator reviews → approved proposals are applied.
381|347|
382|348|```
383|349|ikbi memory proposals              # list pending proposals
384|350|ikbi memory approve <id>           # approve and apply
385|351|ikbi memory reject <id>            # reject
386|352|ikbi memory reject-all             # reject all pending
387|353|ikbi memory stats                  # counts by status
388|354|```
389|355|
390|356|## Running under systemd
391|357|
392|358|A sample unit lives at [`deploy/ikbi.service`](deploy/ikbi.service). It runs the
393|359|service, restarts on failure, sends `SIGTERM` for graceful shutdown, and logs to
394|360|the journal. It is documented but **not installed** — see the comments at the top
395|361|of the file.
396|362|
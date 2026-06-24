/**
 * ikbi contextual help — per-command help pages for `ikbi help <command>`.
 *
 * `ikbi help` prints the focused command list (see `printUsage` in index.ts); `ikbi help
 * <command>` prints the detailed page for that command: a one-line description, the usage
 * syntax, the common flags, a couple of worked examples, and "see also" cross-links. Pages
 * are pure data (the `HELP_PAGES` table) rendered by `renderHelpPage`, so they're trivially
 * testable and carry no provider/network dependency.
 */

/** One flag and what it does, for a command's help page. */
export interface HelpFlag {
  readonly flag: string;
  readonly desc: string;
}

/** One worked example for a command's help page. */
export interface HelpExample {
  readonly cmd: string;
  readonly desc?: string;
}

/** A single command's detailed help page. */
export interface HelpPage {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly flags?: readonly HelpFlag[];
  readonly examples: readonly HelpExample[];
  readonly seeAlso?: readonly string[];
}

export const HELP_PAGES: Readonly<Record<string, HelpPage>> = {
  build: {
    name: "build",
    summary: "Headless build/repair: a 5-role pipeline in an isolated worktree, promoted only on a verified pass.",
    usage: "ikbi build \"<goal>\" [--repo <path>] [--headless] [--quiet] [--json] [--max-budget-usd <n>] [--from-pr <n>]",
    flags: [
      { flag: "--repo <path>", desc: "Target repository (defaults to the current directory)." },
      { flag: "--headless", desc: "Non-interactive mode for CI/scripting — no prompts." },
      { flag: "--quiet", desc: "Suppress progress chatter; emit only the result." },
      { flag: "--json", desc: "Emit a machine-readable JSON result (for scripts/CI)." },
      { flag: "--max-budget-usd <n>", desc: "Abort if the estimated spend would exceed this ceiling." },
      { flag: "--from-pr <n>", desc: "Seed the goal from a GitHub pull request." },
    ],
    examples: [
      { cmd: "ikbi build \"add a --dry-run flag to the export command\"", desc: "Build against the current repo." },
      { cmd: "ikbi build \"fix the failing auth test\" --repo ../service --max-budget-usd 0.50", desc: "Bounded spend on another repo." },
      { cmd: "ikbi build \"implement the issue\" --headless --quiet --json", desc: "CI-friendly invocation." },
    ],
    seeAlso: ["fix", "repl", "models"],
  },
  init: {
    name: "init",
    summary: "Guided first-run setup: detect API keys, pick a model profile, and write a working .env and .ikbi/ config.",
    usage: "ikbi init",
    flags: [],
    examples: [
      { cmd: "ikbi init", desc: "Answer 2-3 prompts and ikbi is ready to use." },
    ],
    seeAlso: ["doctor", "models"],
  },
  models: {
    name: "models",
    summary: "Inspect and configure the model roster — list, rank by benchmark, or apply a blessed profile.",
    usage: "ikbi models [list] [--rank [--min-score <n>]] [--recommend] [--set-recommend <n>]",
    flags: [
      { flag: "(no flag)", desc: "List the roster: id, role, cost, and provider chain." },
      { flag: "--recommend", desc: "Show blessed Budget / Balanced / Max Quality / Local profiles." },
      { flag: "--set-recommend <n>", desc: "Apply profile <n> by writing IKBI_BUILDER_MODEL + IKBI_CRITIC_MODEL to .env." },
      { flag: "--rank", desc: "Rank the roster by Luak benchmark score." },
      { flag: "--min-score <n>", desc: "With --rank: pick the cheapest model at or above that score (0–1 scale)." },
    ],
    examples: [
      { cmd: "ikbi models --recommend", desc: "See the recommended profiles." },
      { cmd: "ikbi models --set-recommend 2", desc: "Apply the Balanced profile to .env." },
      { cmd: "ikbi models --rank --min-score 0.7", desc: "Cheapest model scoring ≥ 0.7 (0–1 scale)." },
    ],
    seeAlso: ["providers", "init", "cost"],
  },
  serve: {
    name: "serve",
    summary: "Start the long-running HTTP service (Fastify): /health, /ready, /agent, /capabilities, /chat.",
    usage: "ikbi serve [--host <addr>] [--port <n>]",
    flags: [
      { flag: "--host <addr>", desc: "Bind address (default localhost; use a Tailscale address to expose on your tailnet)." },
      { flag: "--port <n>", desc: "Listen port (default 18796)." },
    ],
    examples: [
      { cmd: "ikbi serve", desc: "Serve on localhost:18796." },
      { cmd: "ikbi serve --host 0.0.0.0 --port 8080", desc: "Bind all interfaces on a custom port." },
    ],
    seeAlso: ["doctor", "capabilities"],
  },
  repl: {
    name: "repl",
    summary: "Interactive, multi-turn, tool-calling session in a managed worktree (the daily-driver). `ikbi` with no args opens it.",
    usage: "ikbi repl [--continue | --resume <id> | --fork <id>] [--quiet] [--scratch] [--max-sessions <n>]",
    flags: [
      { flag: "--continue, -c", desc: "Resume the most-recent session." },
      { flag: "--resume <id>", desc: "Resume a specific session by id." },
      { flag: "--fork <id>", desc: "Branch a session: clone its history into a fresh session." },
      { flag: "--quiet", desc: "Model-output-only — suppress tool activity and status chatter." },
      { flag: "--scratch", desc: "Use a throwaway scratch workspace (non-promotable)." },
    ],
    examples: [
      { cmd: "ikbi", desc: "Open a fresh interactive session." },
      { cmd: "ikbi \"fix the bug in auth.ts\"", desc: "Open the REPL pre-loaded with a first prompt." },
      { cmd: "ikbi repl --continue", desc: "Pick up where you left off." },
    ],
    seeAlso: ["build", "fix", "models"],
  },
  fix: {
    name: "fix",
    summary: "Diagnose a failing check and repair it narrowly (or correctly refuse). Never promotes; includes a verified retry loop.",
    usage: "ikbi fix <repo> [--quiet] [--json]",
    flags: [
      { flag: "--quiet", desc: "Suppress progress output; emit only the outcome." },
      { flag: "--json", desc: "Emit a machine-readable result." },
    ],
    examples: [
      { cmd: "ikbi fix .", desc: "Diagnose and repair the current repo's failing check." },
      { cmd: "ikbi fix ../service --json", desc: "Scripted repair with JSON output." },
    ],
    seeAlso: ["build", "doctor"],
  },
  doctor: {
    name: "doctor",
    summary: "Report bootstrap config health — what's set, what's missing for a build, and how to fix each gap.",
    usage: "ikbi doctor [--fix] [--force] [--self-repair]",
    flags: [
      { flag: "--fix", desc: "Repair common gaps (.env / state dirs / deps); creates/repairs only." },
      { flag: "--force", desc: "With --fix, also reclaim stale and aged workspaces." },
      { flag: "--self-repair", desc: "Run the self-monitor and file a work order for each problem found." },
    ],
    examples: [
      { cmd: "ikbi doctor", desc: "Read-only health report." },
      { cmd: "ikbi doctor --fix", desc: "Repair common first-run gaps." },
    ],
    seeAlso: ["init", "capabilities"],
  },
  evaluate: {
    name: "evaluate",
    summary: "Run the model capability harness across one or more models and emit a side-by-side scorecard + routing recommendation.",
    usage: "ikbi evaluate [--models <a,b,...>] [--modes <agent,patch,plan_patch,repair>] [--fixture <path>] [--max-extra-files <n>] [--json] [--write-providers]",
    flags: [
      { flag: "--models <a,b,...>", desc: "Models to evaluate (defaults to the configured builder model)." },
      { flag: "--modes <list>", desc: "Which capability modes to show: agent, patch, plan_patch, repair (default: all)." },
      { flag: "--fixture <path>", desc: "A fixture file (one object or an array). Default: .ikbi/fixtures/*.json, else built-ins." },
      { flag: "--repo <dir>", desc: "Repo root used to find .ikbi/fixtures/ (defaults to the current directory)." },
      { flag: "--max-extra-files <n>", desc: "Minimality budget: files a diff may touch beyond the target and still count minimal (default 0)." },
      { flag: "--json", desc: "Emit machine-readable scorecards (for CI)." },
      { flag: "--write-providers", desc: "Merge the routing recommendation into ~/.ikbi/providers.json." },
    ],
    examples: [
      { cmd: "ikbi evaluate", desc: "Score the configured builder on the default fixtures." },
      { cmd: "ikbi evaluate --models deepseek-v4-flash,claude-sonnet-4 --modes agent,patch", desc: "Side-by-side on two models." },
      { cmd: "ikbi evaluate --fixture .ikbi/fixtures/auth.json --json", desc: "Custom fixtures, JSON for CI." },
    ],
    seeAlso: ["models", "build", "providers"],
  },
  review: {
    name: "review",
    summary: "Constructive, structured code review — an overall summary plus file-by-file comments with severity ratings.",
    usage: "ikbi review [path...] [--pr <n>] [--all] [--repo <dir>] [--model <id>] [--json]",
    flags: [
      { flag: "(no scope)", desc: "Review the working tree's current changes (git diff vs HEAD + untracked)." },
      { flag: "path...", desc: "Review the named files instead of the working-tree changes." },
      { flag: "--pr <n>", desc: "Review the changed files of GitHub PR #n (via the gh CLI)." },
      { flag: "--all", desc: "Review a bounded walk of the whole repo." },
      { flag: "--repo <dir>", desc: "Target repository (defaults to the current directory)." },
      { flag: "--model <id>", desc: "Reviewer model (defaults to the configured critic model)." },
      { flag: "--json", desc: "Emit a machine-readable JSON result instead of Markdown." },
    ],
    examples: [
      { cmd: "ikbi review", desc: "Review your uncommitted changes." },
      { cmd: "ikbi review src/auth.ts src/auth.test.ts", desc: "Review specific files." },
      { cmd: "ikbi review --pr 123 --json", desc: "Review PR #123 as JSON for tooling/CI." },
    ],
    seeAlso: ["audit", "build", "fix"],
  },
  agents: {
    name: "agents",
    summary: "List the user-defined agent personas a repo declares in .ikbi/agents/ (reviewer, doc-writer, test-author, …).",
    usage: "ikbi agents [show <name>] [--repo <dir>]",
    flags: [
      { flag: "(no subcommand)", desc: "List the custom agents found in .ikbi/agents/." },
      { flag: "show <name>", desc: "Print one agent's full definition (model, tools, system prompt)." },
      { flag: "--repo <dir>", desc: "Scan a different repo root (defaults to the current directory)." },
    ],
    examples: [
      { cmd: "ikbi agents", desc: "List the available custom agents." },
      { cmd: "ikbi agents show reviewer", desc: "Inspect the reviewer agent's definition." },
    ],
    seeAlso: ["repl", "review"],
  },
  mcp: {
    name: "mcp",
    summary: "[experimental] Run a standalone MCP model+tool loop against a server, and authenticate remote OAuth MCP servers.",
    usage: "ikbi mcp --server \"<command [args...]>\" <goal...> [--model <id>]  |  ikbi mcp auth <server>",
    flags: [
      { flag: "--server \"<cmd>\"", desc: "The MCP server launch command (stdio transport)." },
      { flag: "<goal...>", desc: "The goal the model pursues using the server's tools." },
      { flag: "--model <id>", desc: "Model to drive the loop (defaults to the configured builder)." },
      { flag: "auth <server>", desc: "Run the OAuth flow for a remote MCP server and cache the token." },
    ],
    examples: [
      { cmd: "ikbi mcp --server \"npx -y @modelcontextprotocol/server-filesystem .\" \"list the TODOs\"", desc: "Drive a stdio MCP server." },
      { cmd: "ikbi mcp auth linear", desc: "Authenticate a remote OAuth MCP server." },
    ],
    seeAlso: ["repl", "capabilities"],
  },
  audit: {
    name: "audit",
    summary: "Read-only diagnostic snapshot of a repo — project type, live workspaces, recent receipts; optionally an adversarial multi-model compare.",
    usage: "ikbi audit <repo> [--compare m1,m2] [--structured]",
    flags: [
      { flag: "<repo>", desc: "Path to the repository to snapshot (required)." },
      { flag: "--compare m1,m2", desc: "Run an adversarial scout across the listed models and compare findings." },
      { flag: "--structured", desc: "Emit a machine-readable structured report." },
    ],
    examples: [
      { cmd: "ikbi audit .", desc: "Snapshot the current repo." },
      { cmd: "ikbi audit ../service --compare deepseek-v4-flash,claude-sonnet-4", desc: "Adversarial model compare." },
    ],
    seeAlso: ["review", "receipts", "doctor"],
  },
  cost: {
    name: "cost",
    summary: "Per-task model-cost breakdowns and spend trends, drawn from the receipt store.",
    usage: "ikbi cost [--days <n>] [--task <id>]",
    flags: [
      { flag: "(no flag)", desc: "Show the last 7 days of spend, grouped by task." },
      { flag: "--days <n>", desc: "Report over the last n days instead of 7." },
      { flag: "--task <id>", desc: "Drill into a single task's cost breakdown." },
    ],
    examples: [
      { cmd: "ikbi cost", desc: "Last 7 days of spend." },
      { cmd: "ikbi cost --days 30", desc: "A month of spend trends." },
      { cmd: "ikbi cost --task build-abc123", desc: "One task's breakdown." },
    ],
    seeAlso: ["receipts", "models"],
  },
  diff: {
    name: "diff",
    summary: "Print a workspace's git diff (base..scratch) plus a one-line change summary — inspect what a run produced before promoting or undoing.",
    usage: "ikbi diff <workspace-id>",
    flags: [
      { flag: "<workspace-id>", desc: "The workspace to diff (see `ikbi workspace ls`)." },
    ],
    examples: [
      { cmd: "ikbi diff ws-abc123", desc: "Show what a retained workspace changed." },
    ],
    seeAlso: ["undo", "workspace"],
  },
  undo: {
    name: "undo",
    summary: "Revert a promoted change — shows a preview + diff and asks before reverting. Never promotes; it only rolls back.",
    usage: "ikbi undo <receipt-id|commit|--latest>",
    flags: [
      { flag: "<receipt-id>", desc: "Revert the promote recorded under this receipt id." },
      { flag: "<commit>", desc: "Revert a specific promoted commit." },
      { flag: "--latest", desc: "Revert the most-recent promoted change." },
    ],
    examples: [
      { cmd: "ikbi undo --latest", desc: "Roll back the last promotion." },
      { cmd: "ikbi undo r-abc123", desc: "Roll back a specific receipt's promotion." },
    ],
    seeAlso: ["diff", "receipts"],
  },
  trust: {
    name: "trust",
    summary: "Operator trust management — grant a tier, promote on earned evidence, or inspect an agent's current standing.",
    usage: "ikbi trust grant <agent> <tier> | ikbi trust promote [<agent>] [--yes] | ikbi trust status <agent>",
    flags: [
      { flag: "grant <agent> <tier>", desc: "Grant an agent a starting trust tier (the cold-start on-ramp)." },
      { flag: "promote [<agent>]", desc: "Promote an agent on earned evidence (defaults to the configured worker)." },
      { flag: "status <agent>", desc: "Show an agent's current tier and trust history." },
      { flag: "--yes", desc: "With promote: skip the confirmation prompt." },
    ],
    examples: [
      { cmd: "ikbi trust status worker", desc: "Inspect the worker's standing." },
      { cmd: "ikbi trust grant worker provisional", desc: "Grant a starting tier." },
      { cmd: "ikbi trust promote --yes", desc: "Promote the configured worker without a prompt." },
    ],
    seeAlso: ["doctor", "capabilities"],
  },
  detect: {
    name: "detect",
    summary: "Auto-detect the project's language, framework, test runner, and build tool from its marker files. Read-only, offline.",
    usage: "ikbi detect [--repo <dir>] [--json]",
    flags: [
      { flag: "--repo <dir>", desc: "Detect a different repo root (defaults to the current directory)." },
      { flag: "--json", desc: "Emit a machine-readable detection result (for CI/tooling)." },
    ],
    examples: [
      { cmd: "ikbi detect", desc: "Identify the current project's stack and tooling." },
      { cmd: "ikbi detect --repo ../service --json", desc: "Detect another repo, JSON for scripts." },
    ],
    seeAlso: ["doctor", "audit", "repl"],
  },
  batch: {
    name: "batch",
    summary: "Decompose a large goal into ordered subtasks and build them in dependency order (the multi-step build path).",
    usage: "ikbi batch <goal...> [--repo <path>] [--dry-run]",
    flags: [
      { flag: "<goal...>", desc: "The high-level goal to decompose into subtasks." },
      { flag: "--repo <path>", desc: "Target repository (defaults to the current directory)." },
      { flag: "--dry-run", desc: "Plan the subtasks and print the build order; build nothing." },
    ],
    examples: [
      { cmd: "ikbi batch \"add auth: login, logout, session middleware\"", desc: "Plan + build a multi-part goal." },
      { cmd: "ikbi batch \"migrate the API to v2\" --dry-run", desc: "Preview the decomposition without building." },
    ],
    seeAlso: ["build", "fix", "repl"],
  },
  classify: {
    name: "classify",
    summary: "Classify the intent of a message (the agent-router's read-only intent labeler) — build / fix / ask / chat.",
    usage: "ikbi classify <message...>",
    flags: [
      { flag: "<message...>", desc: "The message whose intent to classify." },
    ],
    examples: [
      { cmd: "ikbi classify \"why is the build failing?\"", desc: "See how the router would label this message." },
    ],
    seeAlso: ["ask", "build", "repl"],
  },
  ask: {
    name: "ask",
    summary: "Ask a question answered over lab memory (project knowledge + prior build context) — read-only, no edits.",
    usage: "ikbi ask <question...> [--project <name>]",
    flags: [
      { flag: "<question...>", desc: "The question to answer from lab memory." },
      { flag: "--project <name>", desc: "Scope the answer to a specific project's memory." },
    ],
    examples: [
      { cmd: "ikbi ask \"how does the trust ladder work?\"", desc: "Answer from accumulated lab memory." },
      { cmd: "ikbi ask \"what changed in auth last week?\" --project service", desc: "Scope to one project." },
    ],
    seeAlso: ["memory", "classify", "repl"],
  },
  recover: {
    name: "recover",
    summary: "Diagnose a broken capability and recommend which module should repair it (operator; non-executing — it never fixes).",
    usage: "ikbi recover <capability> [--project <p>]",
    flags: [
      { flag: "<capability>", desc: "The capability to diagnose (e.g. a failing tool or role)." },
      { flag: "--project <p>", desc: "Scope the diagnosis to a specific project." },
    ],
    examples: [
      { cmd: "ikbi recover run_checks", desc: "Diagnose why the checks capability is broken and who should fix it." },
    ],
    seeAlso: ["doctor", "fix", "audit"],
  },
  memory: {
    name: "memory",
    summary: "Review and manage memory-governance proposals (brain pages, project files) — approve, reject, or inspect stats.",
    usage: "ikbi memory [proposals [--all] | approve <id> | reject <id> | reject-all | stats]",
    flags: [
      { flag: "proposals [--all]", desc: "List pending memory proposals (--all includes resolved)." },
      { flag: "approve <id>", desc: "Approve a proposal — commit it to memory." },
      { flag: "reject <id>", desc: "Reject a single proposal." },
      { flag: "reject-all", desc: "Reject every pending proposal." },
      { flag: "stats", desc: "Show memory-governance counters." },
    ],
    examples: [
      { cmd: "ikbi memory proposals", desc: "See what memory writes are awaiting approval." },
      { cmd: "ikbi memory approve mp-abc123", desc: "Approve one proposal." },
    ],
    seeAlso: ["ask", "summary"],
  },
  receipts: {
    name: "receipts",
    summary: "Show receipt history — the durable record of what ran, what it cost, and whether it verified (with integrity checks).",
    usage: "ikbi receipts [verify] [--task <id>] [--latest] [--failures] [--limit <n>]",
    flags: [
      { flag: "verify", desc: "Verify the integrity (MAC chain) of the receipt store." },
      { flag: "--task <id>", desc: "Show only the receipts for one task." },
      { flag: "--latest", desc: "Show only the most-recent receipt." },
      { flag: "--failures", desc: "Show only failed runs." },
      { flag: "--limit <n>", desc: "Cap the number of receipts shown." },
    ],
    examples: [
      { cmd: "ikbi receipts --latest", desc: "Inspect the most recent run." },
      { cmd: "ikbi receipts --failures --limit 10", desc: "The last 10 failures." },
      { cmd: "ikbi receipts verify", desc: "Check the receipt store's integrity." },
    ],
    seeAlso: ["cost", "summary", "audit"],
  },
  summary: {
    name: "summary",
    summary: "A compact overview of recent build activity (last 24 hours by default) — counts, outcomes, and spend at a glance.",
    usage: "ikbi summary [--days <n>]",
    flags: [
      { flag: "(no flag)", desc: "Summarize the last 24 hours." },
      { flag: "--days <n>", desc: "Summarize the last n days instead." },
    ],
    examples: [
      { cmd: "ikbi summary", desc: "What happened in the last day." },
      { cmd: "ikbi summary --days 7", desc: "A week's overview." },
    ],
    seeAlso: ["receipts", "cost"],
  },
  workspace: {
    name: "workspace",
    summary: "List, discard, or bulk-clean build workspaces (the per-run isolated worktrees) — inspect work before it's promoted.",
    usage: "ikbi workspace <ls | discard <id> | clean [--dry-run] [--retained] [--stale=N] [--force]>",
    flags: [
      { flag: "ls", desc: "List workspaces with their id, state, and target repo." },
      { flag: "discard <id>", desc: "Drop a single workspace and its worktree." },
      { flag: "clean", desc: "Bulk-reclaim terminal workspaces (dry-run unless flags say otherwise)." },
      { flag: "--dry-run", desc: "With clean: show what would be reclaimed; remove nothing." },
      { flag: "--force", desc: "With clean: also sweep retained work." },
    ],
    examples: [
      { cmd: "ikbi workspace ls", desc: "List live workspaces." },
      { cmd: "ikbi workspace discard ws-abc123", desc: "Drop one workspace." },
      { cmd: "ikbi workspace clean --dry-run", desc: "Preview a bulk clean." },
    ],
    seeAlso: ["workspaces", "clean", "diff"],
  },
  workspaces: {
    name: "workspaces",
    summary: "Inspect and manage builder workspaces — list, inspect one in detail, or clean (dry-run by default).",
    usage: "ikbi workspaces <list | inspect <id> | clean [--apply] [--force]>",
    flags: [
      { flag: "list", desc: "List all builder workspaces." },
      { flag: "inspect <id>", desc: "Show one workspace's full detail (state, base, diff summary)." },
      { flag: "clean [--apply]", desc: "Reclaim terminal workspaces — dry-run unless --apply is given." },
      { flag: "--force", desc: "With clean --apply: also sweep retained work." },
    ],
    examples: [
      { cmd: "ikbi workspaces list", desc: "List builder workspaces." },
      { cmd: "ikbi workspaces inspect ws-abc123", desc: "Drill into one workspace." },
      { cmd: "ikbi workspaces clean --apply", desc: "Reclaim terminal workspaces for real." },
    ],
    seeAlso: ["workspace", "clean", "diff"],
  },
  clean: {
    name: "clean",
    summary: "Reclaim orphaned worktrees left by terminal workspaces. Retained work is preserved unless --force sweeps it.",
    usage: "ikbi clean [--force]",
    flags: [
      { flag: "(no flag)", desc: "Reclaim only safely-reclaimable orphaned worktrees." },
      { flag: "--force", desc: "Also reclaim retained (kept-for-inspection) work — destructive." },
    ],
    examples: [
      { cmd: "ikbi clean", desc: "Tidy up orphaned worktrees." },
      { cmd: "ikbi clean --force", desc: "Also sweep retained work (irreversible)." },
    ],
    seeAlso: ["workspace", "workspaces", "doctor"],
  },
  repos: {
    name: "repos",
    summary: "List the registered Pehverse repos (from <stateRoot>/repos.json) — the names `--repo <name>` resolves against.",
    usage: "ikbi repos",
    flags: [],
    examples: [
      { cmd: "ikbi repos", desc: "List the repos you can target by name." },
    ],
    seeAlso: ["build", "fix", "audit"],
  },
  setup: {
    name: "setup",
    summary: "Install a global `ikbi` launcher (shell integration) so `ikbi` runs from any directory. Idempotent.",
    usage: "ikbi setup",
    flags: [],
    examples: [
      { cmd: "ikbi setup", desc: "Write the launcher to ~/.local/bin/ikbi and print any remaining PATH step." },
    ],
    seeAlso: ["init", "doctor"],
  },
  capabilities: {
    name: "capabilities",
    summary: "List the builder + chat tool inventory and the product posture — which surfaces are core vs experimental.",
    usage: "ikbi capabilities",
    flags: [],
    examples: [
      { cmd: "ikbi capabilities", desc: "See every tool the builder/chat expose and each surface's lifecycle guarantees." },
    ],
    seeAlso: ["doctor", "models"],
  },
  providers: {
    name: "providers",
    summary: "List the registered model providers (the backends a role model can route to).",
    usage: "ikbi providers [list]",
    flags: [
      { flag: "(no flag)", desc: "List the registered providers by id." },
    ],
    examples: [
      { cmd: "ikbi providers", desc: "See which providers are wired." },
    ],
    seeAlso: ["models", "init", "doctor"],
  },
  version: {
    name: "version",
    summary: "Print the ikbi version. Offline, no config load.",
    usage: "ikbi version",
    flags: [
      { flag: "--version, -V", desc: "Aliases for `version`." },
    ],
    examples: [
      { cmd: "ikbi version", desc: "Print the installed version." },
    ],
    seeAlso: ["doctor", "capabilities"],
  },
  kill: {
    name: "kill",
    summary: "Engage the engine kill-switch (operator) — latch a stop so new/active work is halted fail-closed.",
    usage: "ikbi kill [--hard] [--agent <id> | --run <id>] [--note <text>]",
    flags: [
      { flag: "--hard", desc: "Hard stop — also interrupt in-flight work, not just new work." },
      { flag: "--agent <id>", desc: "Scope the kill to a single agent." },
      { flag: "--run <id>", desc: "Scope the kill to a single run." },
      { flag: "--note <text>", desc: "Record a reason on the latch." },
    ],
    examples: [
      { cmd: "ikbi kill --note \"prod incident\"", desc: "Latch a soft stop with a reason." },
      { cmd: "ikbi kill --hard --run r-abc123", desc: "Hard-stop one run." },
    ],
    seeAlso: ["kill-status", "unkill"],
  },
  "kill-status": {
    name: "kill-status",
    summary: "Show the current kill-switch state — whether a latch is engaged, its scope, and its note.",
    usage: "ikbi kill-status",
    flags: [],
    examples: [
      { cmd: "ikbi kill-status", desc: "Check whether the engine is currently halted." },
    ],
    seeAlso: ["kill", "unkill"],
  },
  unkill: {
    name: "unkill",
    summary: "Clear the kill-switch latch (operator) — resume normal operation after a `kill`.",
    usage: "ikbi unkill",
    flags: [],
    examples: [
      { cmd: "ikbi unkill", desc: "Release the latch and resume work." },
    ],
    seeAlso: ["kill", "kill-status"],
  },
  spec: {
    name: "spec",
    summary: "Create, list, and inspect spec artifacts — editable plans (goal → reviewable steps) before a build runs.",
    usage: "ikbi spec <create <goal...> | list | status <id> | show <id>>",
    flags: [
      { flag: "create <goal...>", desc: "Generate a draft spec from a goal (sensible defaults; offline decomposition)." },
      { flag: "list", desc: "List all specs with id, status, and step count." },
      { flag: "status <id>", desc: "Show one spec's status and step-by-step progress (plain language)." },
      { flag: "show <id>", desc: "Alias for `status`." },
    ],
    examples: [
      { cmd: "ikbi spec create \"add OAuth login\"", desc: "Generate a reviewable plan." },
      { cmd: "ikbi spec list", desc: "See all specs and their status." },
      { cmd: "ikbi spec status spec-abc123", desc: "Inspect one spec's progress." },
    ],
    seeAlso: ["batch", "build", "job-cards"],
  },
  "job-cards": {
    name: "job-cards",
    summary: "List and inspect job cards — reusable, guardrailed automations (goal template + access/verify/rollback policy).",
    usage: "ikbi job-cards <list | show <id> | runs <id>>",
    flags: [
      { flag: "list", desc: "List all job cards (built-in + saved) with their policy." },
      { flag: "show <id>", desc: "Show one card's policy and guardrails." },
      { flag: "runs <id>", desc: "Show a card's recent run history with human-readable status." },
    ],
    examples: [
      { cmd: "ikbi job-cards list", desc: "See every available automation." },
      { cmd: "ikbi job-cards runs nightly-tests", desc: "Inspect a card's recent runs." },
    ],
    seeAlso: ["spec", "batch", "build"],
  },
};

/** The set of commands that have a detailed help page. */
export function helpTopics(): string[] {
  return Object.keys(HELP_PAGES);
}

/** Render a help page to a printable string (trailing newline included). */
export function renderHelpPage(page: HelpPage): string {
  const lines: string[] = [];
  lines.push(`ikbi ${page.name} — ${page.summary}`);
  lines.push("");
  lines.push(`Usage: ${page.usage}`);
  if (page.flags !== undefined && page.flags.length > 0) {
    lines.push("");
    lines.push("Flags:");
    const width = Math.max(...page.flags.map((f) => f.flag.length));
    for (const f of page.flags) lines.push(`  ${f.flag.padEnd(width + 2)}${f.desc}`);
  }
  if (page.examples.length > 0) {
    lines.push("");
    lines.push("Examples:");
    for (const ex of page.examples) {
      lines.push(`  ${ex.cmd}`);
      if (ex.desc !== undefined) lines.push(`      ${ex.desc}`);
    }
  }
  if (page.seeAlso !== undefined && page.seeAlso.length > 0) {
    lines.push("");
    lines.push(`See also: ${page.seeAlso.map((c) => `ikbi help ${c}`).join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Look up and render a topic's page, or `undefined` if there is no page for it. */
export function helpForTopic(topic: string): string | undefined {
  const page = HELP_PAGES[topic];
  return page === undefined ? undefined : renderHelpPage(page);
}

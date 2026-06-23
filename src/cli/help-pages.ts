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
      { flag: "--min-score <n>", desc: "With --rank: pick the cheapest model at or above that score." },
    ],
    examples: [
      { cmd: "ikbi models --recommend", desc: "See the recommended profiles." },
      { cmd: "ikbi models --set-recommend 2", desc: "Apply the Balanced profile to .env." },
      { cmd: "ikbi models --rank --min-score 70", desc: "Cheapest model above the quality bar." },
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

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

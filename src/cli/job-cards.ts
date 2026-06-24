/**
 * ikbi `job-cards` — list and inspect job cards (reusable, bounded automations).
 *
 * A job card is a named, guardrailed automation (goal template + access/verification/rollback
 * policy). This command is the operator's read surface: `list` shows every available card
 * (built-ins + any saved locally) with human-readable policy, and `runs <id>` shows a card's
 * recent executions with plain-language status rather than internal state tokens.
 *
 *   ikbi job-cards list           list all job cards (built-in + saved)
 *   ikbi job-cards show <id>      show one card's policy + guardrails
 *   ikbi job-cards runs <id>      show a card's recent run history
 */

import { registerCommand } from "./registry.js";
import { writeStdout, writeStderr } from "./io.js";
import { whatNextFooter } from "./what-next.js";
import { BUILTINS, listCards, getCard, getBuiltin, listRuns, type JobCard, type JobCardRun, type JobCardRunStatus } from "../modules/job-cards/index.js";

const USAGE = "ikbi job-cards <list | show <id> | runs <id>>";

/** Plain-language gloss for each run status. */
const RUN_STATUS_LABEL: Readonly<Record<JobCardRunStatus, string>> = {
  pending: "pending — queued, not started",
  running: "running — in progress",
  passed: "passed — completed and verified",
  failed: "failed — see the error",
  "rolled-back": "rolled back — reverted after failure",
};

/** Merge built-in cards with any saved local cards (saved overrides a built-in of the same id). */
function allCards(saved: JobCard[]): JobCard[] {
  const byId = new Map<string, JobCard>();
  for (const c of BUILTINS) byId.set(c.id, c);
  for (const c of saved) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Render one card's policy + guardrails in plain language. */
export function renderCard(card: JobCard): string {
  const lines: string[] = [];
  lines.push(`Job card: ${card.name} (${card.id})`);
  lines.push(`  ${card.description}`);
  lines.push(`  Access:        ${card.accessPolicy}`);
  lines.push(`  Verification:  ${card.verification}`);
  lines.push(`  Rollback:      ${card.rollback}`);
  lines.push(`  Schedule:      ${card.schedule}`);
  lines.push(`  Min trust:     ${card.minTrustTier}`);
  lines.push(`  Goal:          ${card.goalTemplate}`);
  return lines.join("\n");
}

export interface JobCardsCliDeps {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly listSaved?: () => JobCard[];
  readonly get?: (id: string) => JobCard | undefined;
  readonly runs?: (cardId: string) => JobCardRun[];
}

export function createJobCardsCli(deps: JobCardsCliDeps = {}) {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const listSaved = deps.listSaved ?? (() => listCards());
  const get = deps.get ?? ((id: string) => getCard(id) ?? getBuiltin(id));
  const runs = deps.runs ?? ((cardId: string) => listRuns(cardId));

  function run(argv: readonly string[]): void {
    const sub = argv[0] ?? "list";
    if (sub === "--help" || sub === "-h" || sub === "help") {
      out(`Usage: ${USAGE}\n\nList and inspect job cards (reusable, guardrailed automations).\n`);
      return;
    }

    if (sub === "list") {
      const cards = allCards(listSaved());
      out(`Job cards (${cards.length}):\n`);
      for (const c of cards) {
        const builtin = BUILTINS.some((b) => b.id === c.id) ? " (built-in)" : "";
        out(`  • ${c.name}${builtin} — ${c.description}\n`);
        out(`      access: ${c.accessPolicy}, verify: ${c.verification}, rollback: ${c.rollback}, schedule: ${c.schedule}\n`);
      }
      out(`${whatNextFooter("job-cards")}\n`);
      return;
    }

    if (sub === "show") {
      const id = argv[1];
      if (id === undefined) { err("usage: ikbi job-cards show <id>\n"); setExit(1); return; }
      const card = get(id);
      if (card === undefined) { err(`job-cards: no card "${id}" (run \`ikbi job-cards list\`)\n`); setExit(1); return; }
      out(`${renderCard(card)}\n`);
      return;
    }

    if (sub === "runs") {
      const id = argv[1];
      if (id === undefined) { err("usage: ikbi job-cards runs <id>\n"); setExit(1); return; }
      const history = runs(id);
      if (history.length === 0) {
        out(`No runs recorded for card "${id}" yet.\n`);
        return;
      }
      out(`Runs for "${id}" (${history.length}):\n`);
      for (const r of history) {
        const when = r.finishedAt ?? r.startedAt;
        const label = RUN_STATUS_LABEL[r.status] ?? r.status;
        out(`  • ${r.id}  ${label}  (${when})${r.error !== undefined ? ` — ${r.error}` : ""}\n`);
      }
      return;
    }

    err(`job-cards: unknown subcommand "${sub}" — ${USAGE}\n`);
    setExit(1);
  }

  return { run };
}

registerCommand({
  name: "job-cards",
  summary: "List and inspect job cards (reusable, guardrailed automations)",
  usage: USAGE,
  category: "advanced",
  run: (argv) => createJobCardsCli().run(argv),
});

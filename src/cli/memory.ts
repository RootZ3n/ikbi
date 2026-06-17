/**
 * ikbi `memory` — review and manage memory governance proposals.
 *
 * Usage:
 *   ikbi memory proposals [--all]   — list pending (or all) proposals
 *   ikbi memory approve <id>        — approve a proposal (applies it to the target surface)
 *   ikbi memory reject <id>         — reject a proposal (discards it)
 *   ikbi memory reject-all          — reject all pending proposals
 *   ikbi memory stats               — proposal counts by status
 *
 * Proposals are stored under the state root (`~/.ikbi/state/memory-governor/`).
 * Approval writes the proposed content to the target surface (file or brain page).
 */

import { registerCommand } from "./registry.js";
import { createProductionGovernor } from "../modules/memory-governor/create.js";
import type { MemoryGovernor, MemoryProposal } from "../modules/memory-governor/contract.js";

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

function err(s: string): void {
  process.stderr.write(`${s}\n`);
}

function formatProposal(p: MemoryProposal, verbose: boolean): string {
  const age = Date.now() - p.createdAt;
  const ageStr = age < 60_000 ? `${Math.round(age / 1000)}s ago`
    : age < 3_600_000 ? `${Math.round(age / 60_000)}m ago`
    : age < 86_400_000 ? `${Math.round(age / 3_600_000)}h ago`
    : `${Math.round(age / 86_400_000)}d ago`;
  const status = p.status === "pending" ? "⏳ pending" : p.status === "approved" ? "✅ approved" : "❌ rejected";
  const line = `  ${p.id}  ${status}  ${p.surface}/${p.target}  (${ageStr})`;
  if (!verbose) return line;
  const reason = p.reason !== undefined ? `  reason: ${p.reason}` : "";
  const reviewer = p.reviewedBy !== undefined ? `  reviewed by: ${p.reviewedBy}` : "";
  return `${line}${reason}${reviewer}`;
}

async function listProposals(governor: MemoryGovernor, showAll: boolean): Promise<void> {
  const proposals = await governor.list(showAll ? undefined : "pending");
  if (proposals.length === 0) {
    out(showAll ? "No proposals found." : "No pending proposals.");
    return;
  }
  out(`${proposals.length} proposal(s):\n`);
  for (const p of proposals) {
    out(formatProposal(p, false));
  }
  if (!showAll) {
    const all = await governor.list();
    const other = all.length - proposals.length;
    if (other > 0) out(`\n(${other} non-pending proposals hidden; use --all to see all)`);
  }
}

async function approveProposal(governor: MemoryGovernor, id: string): Promise<void> {
  const existing = await governor.get(id);
  if (existing === undefined) {
    err(`Proposal not found: ${id}`);
    process.exitCode = 1;
    return;
  }
  if (existing.status !== "pending") {
    err(`Proposal ${id} is already ${existing.status} — cannot approve.`);
    process.exitCode = 1;
    return;
  }
  const result = await governor.approve(id, "operator");
  if (result === undefined) {
    err(`Failed to approve proposal: ${id}`);
    process.exitCode = 1;
    return;
  }
  out(`Approved: ${id}`);
  out(`  Surface: ${result.surface} → ${result.target}`);
  if (result.surface === "brain_page") {
    out("  (brain page written via gbrain bridge)");
  } else {
    out(`  (content written to ${result.target})`);
  }
}

async function rejectProposal(governor: MemoryGovernor, id: string): Promise<void> {
  const existing = await governor.get(id);
  if (existing === undefined) {
    err(`Proposal not found: ${id}`);
    process.exitCode = 1;
    return;
  }
  if (existing.status !== "pending") {
    err(`Proposal ${id} is already ${existing.status} — cannot reject.`);
    process.exitCode = 1;
    return;
  }
  const result = await governor.reject(id, "operator");
  if (result === undefined) {
    err(`Failed to reject proposal: ${id}`);
    process.exitCode = 1;
    return;
  }
  out(`Rejected: ${id} (${result.surface}/${result.target})`);
}

async function rejectAll(governor: MemoryGovernor): Promise<void> {
  const count = await governor.rejectAll("operator");
  if (count === 0) {
    out("No pending proposals to reject.");
  } else {
    out(`Rejected ${count} pending proposal(s).`);
  }
}

async function showStats(governor: MemoryGovernor): Promise<void> {
  const stats = await governor.stats();
  out(`Memory proposal stats:`);
  out(`  Pending:  ${stats.pending}`);
  out(`  Approved: ${stats.approved}`);
  out(`  Rejected: ${stats.rejected}`);
  out(`  Total:    ${stats.total}`);
}

registerCommand({
  name: "memory",
  summary: "Review and manage memory governance proposals (brain pages, project files)",
  usage: "ikbi memory [proposals [--all] | approve <id> | reject <id> | reject-all | stats]",
  run: async (argv) => {
    const sub = argv[0] ?? "proposals";
    // Construct a governor with the real apply function so approve actually writes.
    // gbrainBridge is best-effort — if it fails to load, brain proposals skip on approve.
    let governor: MemoryGovernor;
    try {
      governor = createProductionGovernor({});
    } catch (e) {
      err(`Failed to initialize memory governor: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
      return;
    }

    switch (sub) {
      case "proposals":
        await listProposals(governor, argv.includes("--all"));
        break;

      case "approve": {
        const id = argv[1];
        if (id === undefined || id.length === 0) {
          err("Usage: ikbi memory approve <proposal-id>");
          process.exitCode = 1;
          return;
        }
        await approveProposal(governor, id);
        break;
      }

      case "reject": {
        const id = argv[1];
        if (id === undefined || id.length === 0) {
          err("Usage: ikbi memory reject <proposal-id>");
          process.exitCode = 1;
          return;
        }
        await rejectProposal(governor, id);
        break;
      }

      case "reject-all":
        await rejectAll(governor);
        break;

      case "stats":
        await showStats(governor);
        break;

      default:
        err(`Unknown memory subcommand: ${sub}`);
        err("Usage: ikbi memory [proposals [--all] | approve <id> | reject <id> | reject-all | stats]");
        process.exitCode = 1;
        break;
    }
  },
});

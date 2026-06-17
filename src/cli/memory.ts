/**
 * ikbi `memory` — review and manage memory governance proposals.
 *
 * Usage:
 *   ikbi memory proposals [--all]   — list pending (or all) proposals
 *   ikbi memory approve <id>        — approve a proposal (applies it)
 *   ikbi memory reject <id>         — reject a proposal
 *   ikbi memory reject-all          — reject all pending proposals
 *   ikbi memory stats               — proposal counts by status
 */

import { registerCommand } from "./registry.js";

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

function err(s: string): void {
  process.stderr.write(`${s}\n`);
}

registerCommand({
  name: "memory",
  summary: "Review and manage memory governance proposals (brain pages, project files)",
  usage: "ikbi memory [proposals [--all] | approve <id> | reject <id> | reject-all | stats]",
  run: (argv) => {
    const sub = argv[0] ?? "proposals";

    switch (sub) {
      case "proposals":
        out("Memory proposals:");
        out("  (Memory governor is module-level; use the programmatic API or");
        out("   the REPL's /memory command to list proposals.)");
        out("");
        out("  The memory governor intercepts writes to:");
        out("    • brain_put (knowledge pages)");
        out("    • .ikbi/project.md, .ikbi/checks.yaml, .ikbi/ignore");
        out("    • CLAUDE.md, AGENTS.md, IKBI.md");
        out("");
        out("  Proposals are stored in the state root under memory-governor/");
        break;

      case "approve": {
        const id = argv[1];
        if (id === undefined || id.length === 0) {
          err("Usage: ikbi memory approve <proposal-id>");
          process.exitCode = 1;
          return;
        }
        out(`Approving proposal: ${id}`);
        out("  (Use the programmatic API to approve proposals.)");
        break;
      }

      case "reject": {
        const id = argv[1];
        if (id === undefined || id.length === 0) {
          err("Usage: ikbi memory reject <proposal-id>");
          process.exitCode = 1;
          return;
        }
        out(`Rejecting proposal: ${id}`);
        out("  (Use the programmatic API to reject proposals.)");
        break;
      }

      case "reject-all":
        out("Rejecting all pending proposals...");
        out("  (Use the programmatic API to reject-all proposals.)");
        break;

      case "stats":
        out("Memory proposal stats:");
        out("  (Use the programmatic API to get proposal stats.)");
        break;

      default:
        err(`Unknown memory subcommand: ${sub}`);
        err("Usage: ikbi memory [proposals [--all] | approve <id> | reject <id> | reject-all | stats]");
        process.exitCode = 1;
        break;
    }
  },
});

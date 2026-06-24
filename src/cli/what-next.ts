/**
 * ikbi "what happened / what next" — contextual next-step suggestions.
 *
 * After a significant command finishes, a first-time user is often left at "OK… now what?".
 * `whatNext(action, result)` returns 1-3 short, copy-pasteable suggestions tailored to the
 * action AND its outcome (e.g. `doctor` with failures suggests fixing the ✗ items; with a
 * clean bill it suggests the first build). `renderWhatNext` formats them as a small footer.
 *
 * Pure data + a tiny renderer — no I/O, no provider/network dependency, trivially testable.
 * Callers print the footer themselves so `--json`/`--quiet` paths can opt out.
 */

/** A structured result some actions pass so suggestions can branch on the outcome. */
export interface WhatNextResult {
  /** Count of problems/issues found (doctor, review, …). 0 ⇒ a clean outcome. */
  readonly issues?: number;
  /** Count of items found (agents, specs, job cards, …). */
  readonly count?: number;
  /** A winner id (evaluate → recommended model). */
  readonly winner?: string;
  /** Whether the action succeeded (default true). */
  readonly ok?: boolean;
  /** A free-form label some actions thread through (e.g. an agent or model name). */
  readonly name?: string;
}

/**
 * Return the contextual next-step suggestions for a completed `action`, branching on the
 * optional `result`. Unknown actions get a single safe fallback. Never throws; never empty.
 */
export function whatNext(action: string, result: WhatNextResult = {}): string[] {
  const issues = result.issues ?? 0;
  const count = result.count ?? 0;
  switch (action) {
    case "init":
      return [
        "Run `ikbi models --recommend` to pick a model profile.",
        "Run `ikbi doctor` to confirm everything is wired.",
      ];
    case "evaluate":
      return result.winner !== undefined
        ? [`Apply the winner: \`ikbi models --set-recommend\` (recommended: ${result.winner}).`, "Re-run with `--write-providers` to persist the routing."]
        : ["Scorecard saved. Apply a recommendation with `ikbi models --set-recommend <n>`."];
    case "review":
      return issues > 0
        ? [`${issues} suggestion(s) found. Run \`ikbi fix .\` to apply the highest-value repair.`, "Or open `ikbi repl` to address them interactively."]
        : ["No blocking issues found. You're clear to commit or open a PR."];
    case "agents":
      return count > 0
        ? [`${count} agent(s) found. Start the REPL and run \`/agent <name>\` to switch onto one.`]
        : ["No custom agents yet. Add one at `.ikbi/agents/<name>.yaml`, then `ikbi agents` to list it."];
    case "mcp-auth":
      return ["OAuth complete. Run `ikbi mcp status` (or re-run your `ikbi mcp` command) to verify the connection."];
    case "doctor":
      return issues > 0
        ? [`Fix the ${issues} ✗ item(s) above, then re-run \`ikbi doctor\`.`, "Run `ikbi doctor --fix` to repair the common ones automatically."]
        : ["Configuration looks healthy. Kick off a build with `ikbi build \"<goal>\"` or open `ikbi repl`."];
    case "detect":
      return [
        "Run `ikbi doctor` to verify the toolchain for this project is installed.",
        "Open `ikbi repl` to start working — ikbi knows your project type.",
      ];
    case "build":
      return result.ok === false
        ? ["The build did not pass verification. Run `ikbi fix .` or inspect the workspace with `ikbi workspace ls`."]
        : ["Inspect the change with `ikbi diff <workspace-id>`, then promote or `ikbi undo --latest` to roll back."];
    case "spec":
      return ["Run `ikbi spec list` to see all specs, or `ikbi spec status <id>` to track progress."];
    case "job-cards":
      return ["Run `ikbi job-cards list` to see all cards, or run one to execute its automation."];
    default:
      return ["Run `ikbi help` to see available commands, or `ikbi doctor` to check your setup."];
  }
}

/**
 * Render suggestions as a compact terminal footer:
 *
 *   Next:
 *     → Run `ikbi models --recommend` to pick a model profile.
 *     → Run `ikbi doctor` to confirm everything is wired.
 *
 * Returns the empty string when there are no suggestions (so callers can print unconditionally).
 */
export function renderWhatNext(suggestions: readonly string[]): string {
  if (suggestions.length === 0) return "";
  const lines = ["", "Next:"];
  for (const s of suggestions) lines.push(`  → ${s}`);
  lines.push("");
  return lines.join("\n");
}

/** Convenience: compute + render in one call (returns "" when there is nothing to suggest). */
export function whatNextFooter(action: string, result: WhatNextResult = {}): string {
  return renderWhatNext(whatNext(action, result));
}

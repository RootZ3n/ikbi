/**
 * Gate configuration diagnostic — printed at CLI startup for promotion-relevant
 * commands (build/fix/repl) so the operator ALWAYS sees the governance posture
 * before work executes.
 *
 * Resting state (secure): `bypass: false`, `insecure dev keys: false`.
 * A deliberate one-off shell override flips either to `true`; when that
 * happens, print a HARD warning: work may execute, but autonomous promotion
 * is forbidden (the gate-wall quarantines the candidate).
 *
 * Writes to stderr ONLY — never stdout, so `--json` output stays clean.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

function insecureDevKeysEnabled(): boolean {
  return (
    process.env.IKBI_ALLOW_INSECURE_DEV_KEYS === "true" ||
    process.env.IKBI_ALLOW_INSECURE_DEV_KEYS === "1"
  );
}

/**
 * Detect whether the bypass value came from an explicit shell override rather
 * than the .env resting state. The .env auto-loader skips keys already present
 * in process.env, so: read the project .env, parse its IKBI_GATE_WALL_BYPASS
 * value, and if the live env differs from the file value (or the file sets
 * nothing), the operator overrode it in the shell.
 */
function readEnvFileValue(key: string): string | undefined {
  try {
    const root = process.cwd();
    const contents = readFileSync(join(root, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      if (t.slice(0, eq).trim() === key) {
        return t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env missing/unreadable — fall through to "override" semantics below.
  }
  return undefined;
}

function source(): string {
  const fileValue = readEnvFileValue("IKBI_GATE_WALL_BYPASS");
  const liveValue = process.env.IKBI_GATE_WALL_BYPASS;
  if (fileValue === undefined) return "shell (no .env value)";
  if (fileValue !== liveValue) return "shell override";
  return ".env (resting state)";
}

/** Render the gate configuration block for stderr. */
export function gateStatusLines(): string[] {
  // Read the LIVE environment — the frozen gateWallConfig singleton captures
  // state at module import, but the diagnostic must report the CURRENT
  // process state (a shell override can happen any time before exec).
  const bypass =
    process.env.IKBI_GATE_WALL_BYPASS === "true" ||
    process.env.IKBI_GATE_WALL_BYPASS === "1";
  const insecure = insecureDevKeysEnabled();
  const lines = [
    "Gate configuration",
    `  bypass: ${bypass}`,
    `  insecure dev keys: ${insecure}`,
    `  source: ${source()}`,
  ];
  if (bypass || insecure) {
    lines.push(
      "",
      "QUARANTINE MODE ACTIVE",
      "Administrative safety bypass detected.",
      "Work may execute, but promotion is forbidden.",
    );
  }
  return lines;
}

/** Print the gate diagnostic to stderr (no-op when the terminal is quiet). */
export function printGateStatus(): void {
  for (const line of gateStatusLines()) {
    process.stderr.write(line + "\n");
  }
}

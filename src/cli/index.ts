#!/usr/bin/env node
/**
 * ikbi CLI — thin stub + module-command composer.
 *
 * Phase 0/1 placeholder for the operator-facing control surface. It exposes the
 * read path into the config-driven provider roster, and — via the command-registrar
 * SEAM (Step S) — composes whatever subcommands MODULES register from their own
 * files. Modules add commands by calling `registerCommand(...)` (see
 * `cli/registry.ts`); this file never names them. Importing the `src/modules`
 * barrel is what makes their commands available — no `cli/index.ts` edit.
 */

// BOOTSTRAP FIRST (before ANY config-loading import): autoload `.env`, and let read-only
// info commands (doctor/help/…) load even on a fresh shell. Imports only node builtins, so
// it cannot transitively pull in core/config — its side effects must land first.
import "./bootstrap.js";
// Side-effect import: load the modules barrel. egress's register() (fired on barrel import)
// installs the SSRF fetch guard, and the provider singleton constructs at module load via
// `resolveFetchGuard()` — so the barrel MUST precede the provider import below, or the CLI
// throws EgressGuardMissingError at startup. This matches the server entry's barrel-first
// ordering. (It also runs each module's command registrations, composing the subcommands.)
import "../modules/index.js";
import { config } from "../core/config.js";
import { registry } from "../core/provider/index.js";
import { trust } from "../core/trust/index.js";
import { commands } from "./registry.js";
import { runDoctor, runDoctorFixCli } from "./doctor.js";
import { runSelfRepair } from "../modules/self-repair/index.js";
import { runCapabilities } from "./capabilities.js";
import { postureLines } from "./posture.js";
import { writeStderr, writeStdout } from "./io.js";
// Core-facing operator commands registered from their own files (read the receipt store /
// workspace manager). Imported here so registerCommand fires before dispatch.
import "./receipts.js";
import "./summary.js";
import "./cost.js";
import "./undo.js";
import "./clean.js";
import "./workspace.js";
import "./workspaces.js";
import "./serve.js";
import "./audit.js";
import "./fix.js";
import "./memory.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
// The DEFAULT router: input that is not a known command is treated as a GOAL and
// deliberated by cognition-layer (which decides the path + recommends the next
// command). Imported AFTER the barrel so the egress guard is already registered.
import { createCognitionRouter } from "../modules/cognition-layer/index.js";

/** Built-in command names — reserved, cannot be shadowed by a module command. */
const BUILTINS = new Set(["version", "models", "providers", "doctor", "capabilities", "help"]);

/**
 * Does this arg list ask for a subcommand's help? (`--help`/`-h` anywhere in the args.)
 * Help must be answerable with NO provider init, NO trust preload, and NO network — so
 * the dispatcher consults this BEFORE the cold-start preload, and each subcommand's own
 * handler prints its usage and returns early. Keeping the check here means a missing/slow
 * model config can never make `ikbi <cmd> --help` hang.
 */
function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/**
 * Auto-run dispatcher for the cognition router: act on a recommendation by re-entering
 * the CLI's own command lookup (`commands.get`). Only KNOWN module commands are ever
 * dispatched — the recommendation maps to build/batch/classify/ask — so this can never
 * loop back into the cognition fallback. This is the seam that turns "recommend" into
 * "do it" while keeping the cognition LAYER itself non-executing.
 */
async function dispatchCommand(argv: readonly string[]): Promise<void> {
  const name = argv[0];
  const sub = name !== undefined ? commands.get(name) : undefined;
  if (sub === undefined) {
    writeStderr(`ikbi: cannot auto-run unrecognized command "${name ?? ""}"\n`);
    return;
  }
  await sub.run(argv.slice(1));
}

/** The default router, with auto-dispatch wired (cli owns the command registry). */
const cognitionRouter = createCognitionRouter({ dispatch: dispatchCommand });

function printUsage(): void {
  const moduleCmds = commands.all().filter((c) => !BUILTINS.has(c.name));
  const lines = [
    `ikbi v${config.version} — governed build/repair engine (experimental CLI)`,
    "",
    "Usage: ikbi <command> | ikbi <goal...> [--project <name>]",
    "",
    "A bare <goal> (anything that is not a command below) is deliberated by the",
    "cognition layer, which decides the path and recommends the next command.",
    "",
    "Commands:",
    "  version            Print the ikbi version",
    "  models [list]      List the model roster (id, role, cost, provider chain)",
    "  providers [list]   List the registered providers",
    "  doctor             Report bootstrap config: what's set, what's missing for a build",
    "  doctor --fix       Repair common gaps (.env/state dirs/deps); --force reclaims stale + aged workspaces",
    "  doctor --self-repair  Run the self-monitor; file a work order per problem found",
    "  capabilities       List the builder + chat tool inventory (and parity)",
  ];
  if (moduleCmds.length > 0) {
    lines.push("", "Module commands:");
    const width = Math.max(...moduleCmds.map((c) => c.name.length));
    for (const c of moduleCmds) {
      const usage = c.usage ? ` ${c.usage}` : "";
      lines.push(`  ${(c.name + usage).padEnd(width + 11)}${c.summary}`);
    }
  }
  lines.push(
    "",
    `Roster file: ${config.provider.rosterFile}`,
    "(Edit that JSON file to add/remove models & providers — no code change.)",
    "",
  );
  writeStdout(lines.join("\n"));
}

function listModels(): void {
  const models = registry.listModels();
  if (models.length === 0) {
    writeStdout("(no models in roster)\n");
    return;
  }
  for (const m of models) {
    const chain = m.providers
      .map((r) => {
        const rate = r.cost ?? m.cost;
        const price = rate ? ` ($${rate.promptPerMTok}/$${rate.completionPerMTok}/Mtok)` : "";
        return `${r.provider}:${r.providerModelId}${price}`;
      })
      .join(" -> ");
    const role = m.role ? ` [${m.role}]` : "";
    writeStdout(`${m.id}${role}  chain=${chain}\n`);
  }
}

function listProviders(): void {
  const providers = registry.listProviders();
  if (providers.length === 0) {
    writeStdout("(no providers registered)\n");
    return;
  }
  for (const p of providers) writeStdout(`${p.id}\n`);
}

/**
 * Run a read-only info command, turning any failure into a friendly ONE-LINE config error
 * (never a raw stack). The bootstrap already lets these commands load on a fresh shell; this
 * is the belt-and-suspenders for any other config-shaped error during their execution.
 */
function runInfo(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeStderr(`ikbi ${name}: configuration error — ${msg}\n  (set the required IKBI_* env vars or add them to a .env file; see README.md / SECURITY.md)\n`);
    process.exitCode = 1;
  }
}

async function run(argv: readonly string[]): Promise<void> {
  const cmd = argv[0];
  switch (cmd) {
    case "version":
    case "--version":
    case "-V":
      // `--version`/`-V` are aliases for `version` — handled here as builtins so they never
      // fall through to the cognition router (which would make a model call to "deliberate"
      // a version request). Pure, offline, no provider init.
      writeStdout(`${config.version}\n`);
      return;
    case "models":
      listModels();
      return;
    case "providers":
      listProviders();
      return;
    case "doctor": {
      const doctorArgs = argv.slice(1);
      // `--help` prints usage and exits 0 — it must NOT run the report (which reads config).
      if (wantsHelp(doctorArgs)) {
        writeStdout(
          "Usage: ikbi doctor [--fix] [--force] [--self-repair]\n\n" +
            "Report bootstrap config: what's set, what's missing for a build, and how to fix each gap.\n" +
            "Read-only by default (no identity, no network).\n\n" +
            "Options:\n" +
            "  --fix          Repair common gaps (.env / state dirs / deps); creates/repairs only\n" +
            "  --force        With --fix, also reclaim stale + aged workspaces\n" +
            "  --self-repair  Run the self-monitor: health/test/workspace/dependency checks;\n" +
            "                 file a work order for each problem found (does not promote/fix)\n",
        );
        return;
      }
      // `--self-repair` runs ikbi's self-monitor (Part 1): cheap read-only checks that
      // file work orders to the shared queue for the mechanic (the Mechanic) to drain. It mints
      // no fix and promotes nothing — it only reports + records.
      if (doctorArgs.includes("--self-repair")) {
        const report = await runSelfRepair(writeStdout);
        // Non-zero whenever ikbi is not actually healthy — a problem that already has an
        // open work order (de-duped) is still unhealthy, so it must not exit 0.
        if (!report.healthy) process.exitCode = 1;
        return;
      }
      // `--fix` is the opt-in side-effecting twin of the read-only report: it repairs
      // common gaps (create/repair only; `--force` reclaims stale + aged workspaces) and
      // sets a non-zero exit code if any repair failed.
      if (doctorArgs.includes("--fix")) {
        const code = await runDoctorFixCli(doctorArgs);
        if (code !== 0) process.exitCode = code;
        return;
      }
      runInfo("doctor", () => writeStdout(`${runDoctor().lines.join("\n")}\n`));
      return;
    }
    case "capabilities":
      // Tool inventory + the shared product posture: which surfaces are core/experimental/dormant,
      // and which lifecycle guarantees each editing surface actually provides (no overstatement).
      runInfo("capabilities", () => writeStdout(`${runCapabilities().lines.join("\n")}\n\n${postureLines().join("\n")}\n`));
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      runInfo("help", printUsage);
      return;
    default: {
      // A subcommand `--help`/`-h` is answered by the command's own handler with NO
      // side effects: skip the cold-start preload + receipt prune entirely so help can
      // never block on durable state, and dispatch straight to the handler (which prints
      // its usage and returns). This is what keeps `ikbi build --help` fast and offline.
      const sawHelp = wantsHelp(argv.slice(1));
      if (!sawHelp) {
        // STARTUP PRELOAD (the cold-start on-ramp's second half): warm the trust cache
        // from durable state BEFORE any command resolves worker trust. Without this, a
        // granted worker still resolves cold to the floor (system.ts cold path) and the
        // grant is invisible. Skipped for the pure-info builtins above (no trust path).
        // A rejected count (MAC failures) is surfaced, never silently dropped.
        try {
          const { rejected } = await trust.preload();
          if (rejected > 0) {
            writeStderr(`ikbi: trust preload rejected ${rejected} unreadable/forged state doc(s) (fail-closed)\n`);
          }
        } catch (err) {
          writeStderr(`ikbi: trust preload failed: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        // H6: best-effort receipt retention prune at startup (non-fatal).
        try {
          const { receipts } = await import("../core/receipt/index.js");
          await receipts.prune();
        } catch { /* non-fatal — receipt pruning is housekeeping, not a startup gate */ }
      }
      // Module commands compose via the command-registrar seam. Built-ins above
      // take precedence (a module cannot shadow a core command).
      const moduleCmd = commands.get(cmd);
      if (moduleCmd !== undefined) {
        await moduleCmd.run(argv.slice(1));
        return;
      }
      // DEFAULT ROUTER: not a known command ⇒ treat the WHOLE input as a goal and let
      // cognition-layer deliberate which path is appropriate. It reports the decision
      // and then AUTO-DISPATCHES the recommended command (via dispatchCommand) unless
      // --no-run was passed. The deliberation IS the routing.
      await cognitionRouter.route(argv);
    }
  }
}

// SIGINT (Ctrl-C): RETAIN cleanly. An interrupt mid-build would otherwise leave the allocated
// workspace leaking the bound and silently abandon whatever the builder had written. On the first
// Ctrl-C we mark every still-live ALLOCATED workspace as retained-failed (keeping its worktree) so
// the work survives and is inspectable (`ikbi workspace ls` / `ikbi diff <id>`); a second Ctrl-C
// force-exits immediately. (PROMOTING workspaces are left for crash-reconcile.)
let interrupting = false;
process.on("SIGINT", () => {
  if (interrupting) process.exit(130); // second Ctrl-C — force quit
  interrupting = true;
  writeStderr("\nikbi: interrupted — retaining in-progress workspaces (Ctrl-C again to force quit)…\n");
  void coreWorkspaces
    .retainAllLive("interrupted by SIGINT")
    .then((n) => {
      if (n > 0) writeStderr(`ikbi: retained ${n} in-progress workspace(s) — inspect with \`ikbi workspace ls\`.\n`);
      process.exit(130);
    })
    .catch(() => process.exit(130));
});

run(process.argv.slice(2)).catch((err: unknown) => {
  writeStderr(`ikbi: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

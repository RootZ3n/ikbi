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

// Side-effect import: load the modules barrel FIRST. egress's register() (fired on
// barrel import) installs the SSRF fetch guard, and the provider singleton constructs
// at module load via `resolveFetchGuard()` — so the barrel MUST precede the provider
// import below, or the CLI throws EgressGuardMissingError at startup. This matches the
// server entry's barrel-first ordering. (It also runs each module's command
// registrations, composing the module subcommands.)
import "../modules/index.js";
import { config } from "../core/config.js";
import { registry } from "../core/provider/index.js";
import { trust } from "../core/trust/index.js";
import { commands } from "./registry.js";
import { runDoctor } from "./doctor.js";
// The DEFAULT router: input that is not a known command is treated as a GOAL and
// deliberated by cognition-layer (which decides the path + recommends the next
// command). Imported AFTER the barrel so the egress guard is already registered.
import { createCognitionRouter } from "../modules/cognition-layer/index.js";

/** Built-in command names — reserved, cannot be shadowed by a module command. */
const BUILTINS = new Set(["version", "models", "providers", "doctor", "help"]);

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
    process.stderr.write(`ikbi: cannot auto-run unrecognized command "${name ?? ""}"\n`);
    return;
  }
  await sub.run(argv.slice(1));
}

/** The default router, with auto-dispatch wired (cli owns the command registry). */
const cognitionRouter = createCognitionRouter({ dispatch: dispatchCommand });

function printUsage(): void {
  const moduleCmds = commands.all().filter((c) => !BUILTINS.has(c.name));
  const lines = [
    `ikbi v${config.version} — build/repair engine (skeleton)`,
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
  process.stdout.write(lines.join("\n"));
}

function listModels(): void {
  const models = registry.listModels();
  if (models.length === 0) {
    process.stdout.write("(no models in roster)\n");
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
    process.stdout.write(`${m.id}${role}  chain=${chain}\n`);
  }
}

function listProviders(): void {
  const providers = registry.listProviders();
  if (providers.length === 0) {
    process.stdout.write("(no providers registered)\n");
    return;
  }
  for (const p of providers) process.stdout.write(`${p.id}\n`);
}

async function run(argv: readonly string[]): Promise<void> {
  const cmd = argv[0];
  switch (cmd) {
    case "version":
      process.stdout.write(`${config.version}\n`);
      return;
    case "models":
      listModels();
      return;
    case "providers":
      listProviders();
      return;
    case "doctor":
      process.stdout.write(`${runDoctor().lines.join("\n")}\n`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    default: {
      // STARTUP PRELOAD (the cold-start on-ramp's second half): warm the trust cache
      // from durable state BEFORE any command resolves worker trust. Without this, a
      // granted worker still resolves cold to the floor (system.ts cold path) and the
      // grant is invisible. Skipped for the pure-info builtins above (no trust path).
      // A rejected count (MAC failures) is surfaced, never silently dropped.
      try {
        const { rejected } = await trust.preload();
        if (rejected > 0) {
          process.stderr.write(`ikbi: trust preload rejected ${rejected} unreadable/forged state doc(s) (fail-closed)\n`);
        }
      } catch (err) {
        process.stderr.write(`ikbi: trust preload failed: ${err instanceof Error ? err.message : String(err)}\n`);
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

run(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`ikbi: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

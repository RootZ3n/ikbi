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

import { config } from "../core/config.js";
import { registry } from "../core/provider/index.js";
import { commands } from "./registry.js";
// Side-effect import: loading the modules barrel runs each module's route/command
// registrations. Keep this AFTER the registry import so the registry exists first.
import "../modules/index.js";

/** Built-in command names — reserved, cannot be shadowed by a module command. */
const BUILTINS = new Set(["version", "models", "providers", "help"]);

function printUsage(): void {
  const moduleCmds = commands.all().filter((c) => !BUILTINS.has(c.name));
  const lines = [
    `ikbi v${config.version} — build/repair engine (skeleton)`,
    "",
    "Usage: ikbi <command>",
    "",
    "Commands:",
    "  version            Print the ikbi version",
    "  models [list]      List the model roster (id, role, cost, provider chain)",
    "  providers [list]   List the registered providers",
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
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    default: {
      // Module commands compose via the command-registrar seam. Built-ins above
      // take precedence (a module cannot shadow a core command).
      const moduleCmd = commands.get(cmd);
      if (moduleCmd !== undefined) {
        await moduleCmd.run(argv.slice(1));
        return;
      }
      process.stderr.write(`ikbi: unknown command "${cmd}"\n\n`);
      printUsage();
      process.exitCode = 1;
    }
  }
}

run(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`ikbi: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * ikbi CLI — thin stub.
 *
 * Phase 0/1 placeholder. The CLI will grow into the operator-facing control
 * surface (status, kill-switch, state inspection) in a later phase. For now it
 * exposes the read path into the config-driven provider roster (the update path
 * lives on the registry API: upsertModel / removeModel / register/removeProvider,
 * or by editing the roster JSON file).
 */

import { config } from "../core/config.js";
import { registry } from "../core/provider/index.js";

function printUsage(): void {
  process.stdout.write(
    [
      `ikbi v${config.version} — build/repair engine (skeleton)`,
      "",
      "Usage: ikbi <command>",
      "",
      "Commands:",
      "  version            Print the ikbi version",
      "  models [list]      List the model roster (id, role, cost, provider chain)",
      "  providers [list]   List the registered providers",
      "",
      `Roster file: ${config.provider.rosterFile}`,
      "(Edit that JSON file to add/remove models & providers — no code change.)",
      "",
    ].join("\n"),
  );
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

function run(argv: readonly string[]): void {
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
    default:
      process.stderr.write(`ikbi: unknown command "${cmd}"\n\n`);
      printUsage();
      process.exitCode = 1;
  }
}

run(process.argv.slice(2));

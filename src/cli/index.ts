#!/usr/bin/env node
/**
 * ikbi CLI — stub.
 *
 * Phase 0 placeholder. The CLI will grow into the operator-facing control
 * surface (status, kill-switch, state inspection) in a later phase.
 */

import { config } from "../core/config.js";

function printUsage(): void {
  process.stdout.write(
    [
      `ikbi v${config.version} — build/repair engine (skeleton)`,
      "",
      "Usage: ikbi <command>",
      "",
      "Commands:",
      "  version    Print the ikbi version",
      "",
      "(No operational commands yet — Phase 0 skeleton.)",
      "",
    ].join("\n"),
  );
}

function run(argv: readonly string[]): void {
  const cmd = argv[0];
  switch (cmd) {
    case "version":
      process.stdout.write(`${config.version}\n`);
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

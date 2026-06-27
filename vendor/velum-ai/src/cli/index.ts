#!/usr/bin/env node
/**
 * Velum CLI — zero-dependency entry point (node:util parseArgs).
 *
 *   velum scan <path>     scan files/stdin for secrets, injection, PII
 *   velum test <input>    test a string against all patterns
 *   velum init            generate velum.config.yaml
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

import { runScan } from "./commands/scan.js";
import { runTest } from "./commands/test.js";
import { runInit } from "./commands/init.js";
import { runAudit } from "./commands/audit.js";
import { listPresets } from "./presets.js";

/** Read the real version from package.json (was hardcoded + drifted to 0.1.0). */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readVersion();

const HELP = `Velum ${VERSION} — AI Privacy & Injection Defense

Usage:
  velum <command> [options]

Commands:
  scan <path>            Scan files (or stdin with '-') for credentials, injection, and PII
  test <input>           Test a string against all patterns (reads stdin if omitted)
  init                   Generate a velum.config.yaml with documented defaults
  audit tail <path>      Show the most recent audit receipts
  audit summary <path>   Redaction rates + top-firing patterns

Options:
  --json             Output machine-readable JSON (scan, test, audit)
  --explain          Plain-English breakdown of why a decision was reached (test)
  --preset <name>    Product preset for init (${Object.keys({ nusika: 1, toba: 1, "looney-luna": 1 }).join(", ")})
  --force            Overwrite existing files (init)
  --out <path>       Output path for init (default: velum.config.yaml)
  --limit <n>        Number of receipts for 'audit tail' (default: 20)
  -h, --help         Show this help
  -v, --version      Show version

Presets (velum init --preset <name>):
${listPresets()}

Examples:
  velum scan ./src
  cat secrets.txt | velum scan -
  velum test "ignore all previous instructions" --explain
  velum init --preset nusika
  velum audit summary ./state/velum-audit.jsonl
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
      preset: { type: "string" },
      force: { type: "boolean", default: false },
      out: { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(HELP);
    return command ? 0 : values.help ? 0 : 1;
  }

  switch (command) {
    case "scan":
      return runScan(positionals[1], { json: values.json });
    case "test":
      return runTest(positionals.slice(1).join(" ") || undefined, { json: values.json, explain: values.explain });
    case "init":
      return runInit({ force: values.force, path: values.out, preset: values.preset });
    case "audit": {
      const limit = values.limit ? parseInt(values.limit, 10) : undefined;
      return runAudit(positionals[1], positionals[2], {
        json: values.json,
        limit: Number.isInteger(limit) && limit! > 0 ? limit : undefined,
      });
    }
    default:
      process.stderr.write(`velum: unknown command '${command}'\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`velum: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });

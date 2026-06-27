/**
 * `velum scan <path>` — scan files (or stdin) for credentials, injection, and PII.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { registry } from "../../core/patterns.js";
import { scanPii } from "../../core/pii.js";
import type { PatternDefinition } from "../../core/patterns.js";

export interface ScanFinding {
  file: string;
  line: number;
  category: string;
  pattern: string;
  severity: string;
  preview: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|env|ya?ml|toml|ini|txt|md|py|rb|go|rs|java|sh|conf|cfg|properties|xml|html|css|sql)$/i;

function walk(path: string, out: string[]): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(join(path, entry), out);
    }
  } else if (st.isFile()) {
    if (st.size <= MAX_FILE_BYTES && (TEXT_EXT.test(path) || !path.includes("."))) out.push(path);
  }
}

function maskPreview(line: string, match: string): string {
  const masked = match.length <= 8 ? "*".repeat(match.length) : `${match.slice(0, 4)}…${"*".repeat(6)}`;
  return line.replace(match, masked).trim().slice(0, 120);
}

function scanTextContent(file: string, text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split(/\r?\n/);

  const credAndPolicy: Array<{ defs: PatternDefinition[]; category: string }> = [
    { defs: registry.credentialPatterns, category: "credential" },
    { defs: registry.injectionPatterns, category: "injection" },
    { defs: registry.policyPatterns, category: "policy" },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { defs, category } of credAndPolicy) {
      for (const def of defs) {
        def.pattern.lastIndex = 0;
        const m = def.pattern.exec(line);
        if (m) {
          findings.push({
            file,
            line: i + 1,
            category,
            pattern: def.name,
            severity: def.severity,
            preview: category === "credential" ? maskPreview(line, m[0]) : line.trim().slice(0, 120),
          });
          def.pattern.lastIndex = 0;
        }
      }
    }
    // PII per line.
    for (const d of scanPii(line)) {
      findings.push({
        file,
        line: i + 1,
        category: "pii",
        pattern: d.type,
        severity: "review",
        preview: maskPreview(line, d.value),
      });
    }
  }

  return findings;
}

export interface ScanOptions {
  json?: boolean;
  cwd?: string;
}

export async function runScan(target: string | undefined, options: ScanOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  let findings: ScanFinding[] = [];

  if (!target || target === "-") {
    const text = await readStdin();
    findings = scanTextContent("<stdin>", text);
  } else {
    const files: string[] = [];
    walk(target, files);
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      findings.push(...scanTextContent(relative(cwd, file) || file, text));
    }
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({ findings, count: findings.length }, null, 2) + "\n");
  } else {
    printTable(findings);
  }

  // Exit non-zero when blocking-severity findings exist (useful in CI).
  return findings.some((f) => f.severity === "block") ? 1 : 0;
}

function printTable(findings: ScanFinding[]): void {
  if (findings.length === 0) {
    process.stdout.write("✓ No secrets, injection, or PII detected.\n");
    return;
  }
  process.stdout.write(`\nVelum scan — ${findings.length} finding(s):\n\n`);
  for (const f of findings) {
    const tag = f.severity === "block" ? "BLOCK " : f.severity === "review" ? "REVIEW" : "WARN  ";
    process.stdout.write(`  [${tag}] ${f.category}/${f.pattern}\n`);
    process.stdout.write(`           ${f.file}:${f.line}\n`);
    process.stdout.write(`           ${f.preview}\n\n`);
  }
  const blocking = findings.filter((f) => f.severity === "block").length;
  if (blocking > 0) process.stdout.write(`✗ ${blocking} blocking finding(s).\n`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

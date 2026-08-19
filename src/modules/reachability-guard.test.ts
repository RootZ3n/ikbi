/**
 * Reachability guard — the cheap, deterministic anti-phantom floor.
 *
 * The phantom-integration audit (see scripts/proving-ground/REACHABILITY-REPORT.md)
 * found that unit tests prove a module WORKS in isolation and code audits review files
 * that EXIST — neither proves a module is actually WIRED into a live flow. A module can
 * pass dozens of tests, be declared "the engine" in CLAUDE.md, and never execute. That is
 * the blind spot this guard closes.
 *
 * THE INVARIANT: every directory under src/modules/ must be either
 *   (a) WIRED  — imported by at least one non-test .ts file outside its own directory
 *                (the barrel `./mod/index.js`, a CLI command, or a consumer module), OR
 *   (b) LABELED — carry an explicit `@status dormant | library-only | partially-wired`
 *                tag in one of its own source files, honestly declaring it has no live path.
 *
 * A module that is NEITHER is a silent phantom: declared but wired nowhere and not owning
 * up to it. This test fails on exactly that — so a new module cannot slip in declared-but-dead.
 *
 * This is the CHEAP gate (static, free, runs every `pnpm test`). It proves a module has a
 * POTENTIAL path or an honest label — NOT that it actually executes. The GROUND-TRUTH proof
 * of execution is the runtime self-coverage harness (scripts/proving-ground/reachability.mjs),
 * which runs each surface under V8 coverage. Run that periodically (it costs model tokens);
 * run this on every build.
 *
 * IMPORTANT — the import scan MUST catch relative barrel imports (`./mod/…`). A naive grep
 * that only looked for `modules/<mod>/` missed those and produced FALSE phantoms in the
 * audit that motivated this guard. The detection below matches any specifier resolving into
 * `<mod>/`, relative or not.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const modulesDir = fileURLToPath(new URL(".", import.meta.url)); // src/modules/
const srcDir = fileURLToPath(new URL("..", import.meta.url)); // src/

function walkTs(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkTs(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const moduleNames = readdirSync(modulesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const allSourceFiles = walkTs(srcDir);
const importSpec = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/**
 * Any non-test file OUTSIDE `mod/` whose import specifier RESOLVES into `src/modules/<mod>/`.
 * A RELATIVE specifier is resolved against the importing file so it must land in the module dir — a
 * bare substring match would false-wire a module that merely shares a core dir's name (e.g. a module
 * `trust` credited to `../../core/trust/…`). A non-relative specifier is matched on `modules/<mod>/`.
 */
const modulesRoot = join(srcDir, "modules");
function hasNonTestImporter(mod: string): string | null {
  const modDir = join(modulesRoot, mod);
  for (const file of allSourceFiles) {
    if (file.includes(`/modules/${mod}/`)) continue;
    const src = readFileSync(file, "utf8");
    importSpec.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = importSpec.exec(src)) !== null) {
      const spec = m[1] ?? "";
      const lands = spec.startsWith(".")
        ? resolve(dirname(file), spec).startsWith(modDir + "/") || resolve(dirname(file), spec) === modDir
        : spec.includes(`/modules/${mod}/`) || spec.endsWith(`/modules/${mod}`);
      if (lands) return file.replace(srcDir, "src/");
    }
  }
  return null;
}

/** An explicit dormancy label in any of the module's own source files. */
function statusLabel(mod: string): string | null {
  const dir = join(modulesDir, mod);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const m = readFileSync(join(dir, f), "utf8").match(/@status (dormant|library-only|partially-wired)/);
    if (m) return m[1] ?? null;
  }
  return null;
}

test("every declared module is WIRED (a non-test importer) or LABELED (@status dormant) — no silent phantoms", () => {
  const phantoms: string[] = [];
  for (const mod of moduleNames) {
    const importer = hasNonTestImporter(mod);
    const label = statusLabel(mod);
    if (!importer && !label) phantoms.push(mod);
  }
  assert.deepEqual(
    phantoms,
    [],
    `these module dirs are wired nowhere AND carry no @status dormant/library-only label — ` +
      `either wire them (barrel/command/route/consumer), delete them, or add an honest @status ` +
      `label to their index. Silent phantoms: ${phantoms.join(", ")}`,
  );
});

// ── V2-020/Phase 17: TypeScript sources must be plain text ──────────────────

test("guard: no .ts source file contains a raw NUL byte", () => {
  // A raw NUL makes `file`, `grep` and most line-oriented tooling treat the file as BINARY and
  // skip it SILENTLY. That is not cosmetic: `src/v2/core/cost.ts` — the canonical cost/accounting
  // authority — carried two NULs as sort-key separators, and every grep-based static guard in this
  // repository skipped the whole file without saying so. The escape sequence is byte-identical at
  // runtime and keeps the file greppable, so there is no reason to write the literal byte.
  const NUL = 0;
  const offenders: string[] = [];
  const walkAll = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) { walkAll(abs); continue; }
      if (!e.name.endsWith(".ts")) continue;
      if (readFileSync(abs).includes(NUL)) offenders.push(abs.slice(srcDir.length));
    }
  };
  walkAll(srcDir);
  assert.deepEqual(offenders, [], "write the \\u0000 escape sequence, never a literal NUL byte");
});

/**
 * THE V1/V2 BOUNDARY GUARD.
 *
 * v2 is a new spine built inside the v1 repository. The failure mode to prevent is
 * the obvious one: a slow drift into a tangled hybrid where neither architecture is
 * intact and neither can be reasoned about. So the boundary is a TEST, not a habit.
 *
 *   - `src/v2/core/**` (and the `src/v2/index.ts` barrel) imports nothing but node
 *     builtins and other v2 files.
 *   - `src/v2/cli/**` may additionally import the v1 CLI command registrar and its
 *     io helpers — that is how a v2 command becomes reachable at all.
 *   - `src/v2/runtime/**` is the ADAPTER layer and may import a NAMED, enumerated set
 *     of v1 donor modules. It exists so that "v2 reads v1" is a short, reviewable list
 *     in one place instead of an ambient habit.
 *   - No v1 file imports v2, with exactly ONE sanctioned exception: the side-effect
 *     registration line in `src/cli/index.ts`.
 *
 * When a later slice legitimately adopts a v1 primitive, it edits the allowlist here
 * — deliberately, visibly, in review. That is the whole point.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const V2_DIR = join(SRC, "v2");

/** v1 modules `src/v2/cli/**` is allowed to import (relative to the importing file). */
const V2_CLI_ALLOWED_V1_IMPORTS = new Set(["../../cli/registry.js", "../../cli/io.js"]);

/**
 * v1 donor modules the ADAPTER layer may import. Every entry is a deliberate decision
 * recorded in docs/V2-DONOR-CLASSIFICATION.md. Growing this list is how v2 legitimately
 * adopts a v1 primitive — in review, on purpose, never by drift.
 */
const V2_RUNTIME_ALLOWED_V1_IMPORTS = new Set([
  "../../core/config.js", //                       operator/provider configuration + state root
  "../../core/provider/index.js", //               the process-wide model registry (dynamic)
  "../../core/provider/contract.js", //            ModelProvider / preflight metadata types
  "../../core/provider/registry.js", //            ModelSpec / ModelRegistry types
  "../../modules/profiles/contract.js", //         Profile shape + the role vocabulary
  "../../modules/profiles/storage.js", //          READ-ONLY profile loading + the active pointer
]);

/** The ONLY v1 file permitted to know v2 exists. */
const V1_REGISTRATION_FILE = "cli/index.ts";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Every module specifier a file imports (static, side-effect, re-export, multi-line,
 * dynamic). Matched LINE-ANCHORED at statement position — a naive whole-file scan for
 * `from "…"` also matches ordinary prose inside template literals and doc comments.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /^\s*(?:import|export)\s[^"']*\bfrom\s*["']([^"']+)["']/, // import x from "…" / export … from "…"
  /^\s*(?:import|export)\s*["']([^"']+)["']/, //                  side-effect import "…"
  /^\s*\}\s*from\s*["']([^"']+)["']/, //                          the tail of a multi-line import
  /^\s*(?:const|let|var|return|await)?[^"']*\bimport\s*\(\s*["']([^"']+)["']/, // dynamic import("…")
];

function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    for (const re of SPECIFIER_PATTERNS) {
      const m = re.exec(line);
      if (m?.[1] !== undefined) {
        found.push(m[1]);
        break;
      }
    }
  }
  return found;
}

const isBuiltin = (spec: string): boolean => spec.startsWith("node:");

test("isolation: the import scanner is not vacuous (it really finds imports)", () => {
  // A guard that silently matches nothing would pass every other test in this file.
  const identity = importSpecifiers(readFileSync(join(V2_DIR, "core", "identity.ts"), "utf8"));
  assert.deepEqual(identity, ["node:crypto"]);
  const cli = importSpecifiers(readFileSync(join(V2_DIR, "cli", "index.ts"), "utf8"));
  assert.ok(cli.includes("../../cli/registry.js"), `expected the registrar import, saw ${cli.join(", ")}`);
  assert.ok(cli.includes("../runtime/index.js"), `expected the production run import, saw ${cli.join(", ")}`);
  const runtime = importSpecifiers(readFileSync(join(V2_DIR, "runtime", "index.ts"), "utf8"));
  assert.ok(runtime.includes("../core/run.js"), `expected the canonical run import, saw ${runtime.join(", ")}`);
  assert.ok(runtime.includes("../../core/provider/index.js"), "the dynamic v1 provider import is seen by the scanner");
});

test("isolation: nothing under src/v2/core (or the barrel) imports v1", () => {
  const barrel = join(V2_DIR, "index.ts");
  for (const file of [...tsFiles(join(V2_DIR, "core")), barrel]) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (isBuiltin(spec)) continue;
      assert.ok(spec.startsWith("."), `${relative(SRC, file)} imports a bare package "${spec}"`);
      const target = resolve(file, "..", spec);
      assert.ok(target.startsWith(`${V2_DIR}/`), `${relative(SRC, file)} imports OUTSIDE v2: ${spec}`);
    }
  }
});

test("isolation: src/v2/cli imports only v2 + the sanctioned v1 CLI registrar/io", () => {
  for (const file of tsFiles(join(V2_DIR, "cli"))) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (isBuiltin(spec) || V2_CLI_ALLOWED_V1_IMPORTS.has(spec)) continue;
      assert.ok(spec.startsWith("."), `${relative(SRC, file)} imports a bare package "${spec}"`);
      const target = resolve(file, "..", spec);
      assert.ok(
        target.startsWith(`${V2_DIR}/`),
        `${relative(SRC, file)} imports v1 "${spec}" — add it to V2_CLI_ALLOWED_V1_IMPORTS deliberately, or don't`,
      );
    }
  }
});

test("isolation: src/v2/runtime imports only v2 + the ENUMERATED v1 donor modules", () => {
  for (const file of tsFiles(join(V2_DIR, "runtime"))) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (isBuiltin(spec) || V2_RUNTIME_ALLOWED_V1_IMPORTS.has(spec)) continue;
      assert.ok(spec.startsWith("."), `${relative(SRC, file)} imports a bare package "${spec}"`);
      const target = resolve(file, "..", spec);
      assert.ok(
        target.startsWith(`${V2_DIR}/`),
        `${relative(SRC, file)} imports un-enumerated v1 module "${spec}" — add it to ` +
          "V2_RUNTIME_ALLOWED_V1_IMPORTS deliberately, and record the decision in the donor classification",
      );
    }
  }
});

test("isolation: the adapter layer is the ONLY part of v2 that touches v1 donor code", () => {
  // A guard against the easy mistake: reaching for v1 from core or cli because the
  // adapter did not expose quite the right shape yet.
  for (const dir of ["core", "cli"] as const) {
    for (const file of tsFiles(join(V2_DIR, dir))) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        assert.equal(
          V2_RUNTIME_ALLOWED_V1_IMPORTS.has(spec),
          false,
          `${relative(SRC, file)} imports donor module "${spec}" directly — that belongs in src/v2/runtime`,
        );
      }
    }
  }
});

test("isolation: v1 does not import v2, except the single registration line", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel.startsWith("v2/")) continue;
    const specs = importSpecifiers(readFileSync(file, "utf8")).filter((s) => /(^|\/)v2\//.test(s));
    if (specs.length === 0) continue;
    if (rel === V1_REGISTRATION_FILE) {
      assert.deepEqual(specs, ["../v2/cli/index.js"], "the registration seam imports the v2 CLI and nothing else");
      continue;
    }
    offenders.push(`${rel} -> ${specs.join(", ")}`);
  }
  assert.deepEqual(offenders, [], "v1 must not depend on v2");
});

test("isolation: the registration seam is actually present (v2 is reachable at all)", () => {
  const cli = readFileSync(join(SRC, V1_REGISTRATION_FILE), "utf8");
  // Built with `new RegExp` on purpose: writing the import statement literally in this
  // file would be picked up by this suite's own scanner as a v1 import from v2/core.
  const registration = new RegExp(String.raw`import\s+"\.\./v2/cli/index\.js";`);
  assert.match(cli, registration, "src/cli/index.ts registers the v2 command");
});

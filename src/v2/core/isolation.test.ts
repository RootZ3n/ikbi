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
  "../../core/provider/capabilities.js", //        static capability classification (V2-003)
  "../../core/provider/providers/openai-compatible.js", // the transport, for the adapter's own tests (V2-005)
  "../../core/workspace/contract.js", //           WorkspaceHandle type (V2-006)
  "../../core/workspace/git.js", //                reading the base tree of a new workspace
  "../../core/workspace/index.js", //              the workspace manager singleton (dynamic)
  "../../core/workspace/manager.js", //            WorkspaceManager type + test construction
  "../../core/workspace/mutation.js", //           THE state-bound mutation core
  "../../core/substrate/lock.js", //               lock manager, for the adapter's own tests
  "../../core/substrate/store.js", //              document store, for the adapter's own tests
  "pino", //                                       the logger the donor manager requires (tests only)
  "../../modules/profiles/contract.js", //         Profile shape + the role vocabulary
  "../../modules/profiles/storage.js", //          READ-ONLY profile loading + the active pointer
]);

/**
 * v1 model-SELECTION machinery. Every one of these is a way v1 decides which model to
 * use; in v2 that decision has exactly one owner (`src/v2/core/resolver.ts`). They are
 * parked donors — each may one day become a STRATEGY INSIDE the resolver, and none may
 * ever become a second path to a model.
 */
/**
 * v1 CONTEXT machinery. Each of these can put text in front of a model. In v2 exactly
 * one component assembles context (`src/v2/core/context.ts`), and downstream code
 * receives a `ContextPackage` — never a raw source. They are parked donors; importing
 * one into v2 would be a second way for content to reach a builder.
 */
const V1_CONTEXT_AUTHORITIES: readonly string[] = [
  "context-manager", //   model-driven mid-conversation compaction
  "context-preflight", // the pre-flight size heuristic
  "context-layer", //     deterministic in-loop compression
  "context-packets", //   dormant packet builder
  "project-index", //     repository indexing
  "project-retrieval", // index-backed relevance retrieval
  "project-memory", //    v1's concatenated instruction loader
  "lab-context-memory", //cross-agent memory
  "labmem-recall",
  "gbrain", //            external knowledge recall (spawns a process)
];

const V1_SELECTION_AUTHORITIES: readonly string[] = [
  "model-router", //     resolveModel / cheapest-sufficient routing
  "expert-rental", //    MoE expert selection
  "role-models", //      driverModel / builderModel / criticModel
  "tier-presets", //     --tier cheap/mid/frontier
  "model-evaluation", // Luak leaderboard ranking
  "escalation", //       up-the-ladder model escalation
  "consult", //          consultModel
  "orchestrator", //     the v1 build-path model decisions
];

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

/**
 * Strip comments before scanning source for forbidden CALLS.
 *
 * These guards look for what code DOES. A doc comment explaining that `writeFile(path,
 * content)` deliberately does not exist is the opposite of a violation, and a guard that
 * cannot tell the difference teaches people to stop writing the explanation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

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

test("single authority: no v2 file imports v1 model-SELECTION machinery", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      const authority = V1_SELECTION_AUTHORITIES.find((name) => spec.includes(`/${name}`) || spec.endsWith(`${name}.js`));
      if (authority !== undefined) offenders.push(`${relative(SRC, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "model selection has exactly one owner in v2 (src/v2/core/resolver.ts); these belong to v1 and are parked",
  );
});

test("single authority: only the configuration adapter may read IKBI_MODEL_* variables", () => {
  // Configuration is captured ONCE, into RuntimeModelPolicy. Anything downstream that
  // reached for an env var would be a second, unaudited source of model truth.
  const allowed = join(V2_DIR, "runtime", "operator-defaults.ts");
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file === allowed || file.endsWith(".test.ts")) continue;
    const source = readFileSync(file, "utf8");
    if (/\bIKBI_MODEL_[A-Z_]*\b/.test(source) && !/^\s*(\*|\/\/)/m.test(source.split("\n").find((l) => /IKBI_MODEL_/.test(l)) ?? "")) {
      offenders.push(relative(SRC, file));
    }
  }
  assert.deepEqual(offenders, [], `only ${relative(SRC, allowed)} may name the model env vars`);
});

test("single authority: only the resolver CHOOSES among routes or mints a decision", () => {
  // Two crisp signatures of a second selection path: scanning a fallback chain for a
  // winner (`routes.findIndex`), and constructing a ModelResolutionDecision at all.
  const resolverFile = join(V2_DIR, "core", "resolver.ts");
  const chooses: string[] = [];
  const mints: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file === resolverFile || file.endsWith(".test.ts")) continue;
    const source = readFileSync(file, "utf8");
    if (/routes\s*\.\s*findIndex\s*\(/.test(source)) chooses.push(relative(SRC, file));
    // Computing a decision's content address IS minting a decision. Recording an
    // already-minted id as lifecycle evidence (which run.ts does) is not.
    if (/contentDigest\s*\(\s*"decision"/.test(source)) mints.push(relative(SRC, file));
  }
  assert.deepEqual(chooses, [], "walking a fallback chain for a winner belongs to src/v2/core/resolver.ts alone");
  assert.deepEqual(mints, [], "only the resolver may construct a ModelResolutionDecision");
});

test("single authority: only the workspace adapter may create a worktree or write a file", () => {
  // The rule V2-006 exists to make structural: no v2 component writes a repository or
  // workspace file except through the state-bound mutation authority. A `writeFileSync`
  // or a `git worktree` anywhere else is how that would quietly stop being true.
  // The materializer writes too, and is allowed to: it CONSTRUCTS a workspace's initial
  // state from the run's source snapshot. That is a different act from mutating an
  // existing candidate, and the next guard keeps it from becoming a general write API.
  const allowed = new Set([join(V2_DIR, "runtime", "workspace-authority.ts"), join(V2_DIR, "runtime", "source-materializer.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    // Test fixtures legitimately create repositories and plant files to be observed.
    if (allowed.has(file) || file.endsWith(".test.ts") || file.endsWith("fixture-repo.ts") || file.endsWith("fake-provider-server.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/\bwriteFileSync?\s*\(|\bwriteFile\s*\(|\bunlinkSync?\s*\(|\brenameSync?\s*\(|\brmSync?\s*\(/.test(source)) {
      offenders.push(`${relative(SRC, file)} (filesystem write)`);
    }
    if (/["']worktree["']/.test(source)) offenders.push(`${relative(SRC, file)} (git worktree)`);
  }
  assert.deepEqual(offenders, [], "repository and workspace writes go through src/v2/runtime/workspace-authority.ts alone");
});

test("single authority: only the workspace authority may import the SOURCE MATERIALIZER", () => {
  // Materialization is allowed to write because it builds a workspace's INITIAL state
  // from the snapshot. A future builder importing it would turn "set up the starting
  // state" into a general write API — the exact escape hatch state-bound mutation removes.
  const allowed = new Set([join(V2_DIR, "runtime", "workspace-authority.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts") || file.endsWith("source-materializer.ts")) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.includes("source-materializer")) offenders.push(`${relative(SRC, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "only src/v2/runtime/workspace-authority.ts may materialize a snapshot");
});

test("single authority: only the snapshot module captures working-tree state", () => {
  // Everything else reads through the run's SourceSnapshotReader. A second component
  // asking git what the working tree looks like would be a second source reality.
  const allowed = new Set([join(V2_DIR, "runtime", "source-snapshot.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts") || file.endsWith("fixture-repo.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/["']status["']\s*,\s*["']--porcelain|ls-files|["']diff["']/.test(source)) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "working-tree capture belongs to src/v2/runtime/source-snapshot.ts alone");
});

test("single authority: context sources never touch the filesystem", () => {
  // V2-006A moved every repository read behind the snapshot reader. A context source
  // importing `node:fs` would be reading a source reality the run is not bound to.
  const specs = importSpecifiers(readFileSync(join(V2_DIR, "runtime", "context-sources.ts"), "utf8"));
  assert.equal(
    specs.some((spec) => spec.startsWith("node:")),
    false,
    `context sources read through the snapshot only, but import: ${specs.join(", ")}`,
  );
});

test("single authority: only the source module mints a snapshot identity", () => {
  // The materializer also digests under this kind — for its materialization PROOF, which
  // is a statement about a workspace rather than a new source identity.
  const allowed = new Set([join(V2_DIR, "core", "source.ts"), join(V2_DIR, "runtime", "source-materializer.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/contentDigest\s*\(\s*"snapshot"/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "source snapshot identity belongs to src/v2/core/source.ts");
});

test("single authority: no v2 file uses v1 mutation SESSION primitives directly", () => {
  // v1 has two write surfaces: the state-bound core (adopted) and a session layer plus
  // several raw `writeFileSync` tool paths (parked). v2 uses the core and nothing else.
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (/mutation-session|repair-plan|builder-tools|tool-executor/.test(spec)) offenders.push(`${relative(SRC, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "v2 adopts the mutation CORE; the session and tool write paths are parked");
});

test("single authority: only the workspace module mints an observation or mutation identity", () => {
  const allowed = new Set([join(V2_DIR, "core", "workspace.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/contentDigest\s*\(\s*"(observation|mutation)"/.test(source)) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "observation and mutation identity belong to src/v2/core/workspace.ts alone");
});

test("single authority: v2 never calls the donor PROMOTE path", () => {
  // Promotion is its own authority in a later slice. Reaching for the donor's promote
  // here would create exactly the second promote path v2 exists to prevent.
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    if (/\.promote\s*\(/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "promotion is parked for its own slice");
});

test("single authority: only the transport adapter may reach a provider TRANSPORT", () => {
  // Generation is the invocation authority's alone. Anything else instantiating a
  // transport, calling `provider.invoke`, or reaching for the v1 INVOKER (which is a
  // routing authority, not a transport) would be a second way to call a model.
  const allowed = new Set([join(V2_DIR, "runtime", "invocation-transport.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    const source = readFileSync(file, "utf8");
    if (/\.invoke\s*\(|\bnew (OpenAICompatible|Anthropic)Provider\b|\binvokeModel\s*\(/.test(source)) {
      offenders.push(relative(SRC, file));
    }
  }
  assert.deepEqual(offenders, [], "model generation goes through src/v2/runtime/invocation-transport.ts alone");
});

test("single authority: only the invocation authority mints an invocation identity", () => {
  // `ids.mint("invocation")` in the run is the one place an attempt gets an identity,
  // and only because that is where an attempt actually happens.
  const allowed = new Set([join(V2_DIR, "core", "run.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/mint\s*\(\s*"invocation"\s*\)/.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "a V2InvocationId is minted where an invocation is performed, nowhere else");
});

test("single authority: only the invocation module builds an invocation record", () => {
  const invocationFile = join(V2_DIR, "core", "invocation.ts");
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file === invocationFile || file.endsWith(".test.ts")) continue;
    if (/classifyServedIdentity\s*\(/.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "served-identity classification belongs to src/v2/core/invocation.ts alone");
});

test("single authority: the model-input renderer consumes the package and nothing else", () => {
  // V2-004's rule, enforced at the point it now matters most: the thing that builds a
  // prompt must not be able to reach a repository reader.
  const specs = importSpecifiers(readFileSync(join(V2_DIR, "core", "prompt.ts"), "utf8"));
  assert.deepEqual([...new Set(specs)].sort(), ["./context.js", "./identity.js"], "the renderer reads the authorized package only");
});

test("single authority: no v2 file imports v1 CONTEXT machinery", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      const authority = V1_CONTEXT_AUTHORITIES.find((name) => spec.includes(`/${name}`) || spec.endsWith(`${name}.js`));
      if (authority !== undefined) offenders.push(`${relative(SRC, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "context has exactly one owner in v2 (src/v2/core/context.ts); these belong to v1 and are parked",
  );
});

test("single authority: only the context module assembles or mints a context package", () => {
  // Computing a package's content address IS assembling context. Recording an already
  // minted id as lifecycle evidence (which run.ts does) is not.
  const contextFile = join(V2_DIR, "core", "context.ts");
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file === contextFile || file.endsWith(".test.ts")) continue;
    if (/contentDigest\s*\(\s*"context"/.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "only src/v2/core/context.ts may construct a ContextPackage");
});

test("single authority: a context SOURCE cannot reach downstream — only the assembler can", () => {
  // The structural guarantee: `ContextSource` is consumed by the assembler and wired in
  // exactly one place. Nothing else may hold the production source list.
  const allowed = new Set([join(V2_DIR, "runtime", "context-sources.ts"), join(V2_DIR, "runtime", "index.ts"), join(V2_DIR, "core", "context.ts"), join(V2_DIR, "core", "run.ts"), join(V2_DIR, "cli", "index.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/\bPRODUCTION_CONTEXT_SOURCES\b|\bContextSource\b/.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "context sources are held by the assembler's wiring alone; everything else receives a ContextPackage");
});

test("single authority: only the catalog module declares catalog or discovery FACTS", () => {
  // A second built-in list or a second auto-discovery mapping appearing anywhere else is
  // how inventory truth would quietly fork. There is one of each, in one file.
  const catalogFile = join(V2_DIR, "runtime", "model-catalog.ts");
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file === catalogFile || file.endsWith(".test.ts")) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/^export const (\w*(?:CATALOG|AUTO_DISCOVERY|BUILTIN)\w*)/gm)) {
      offenders.push(`${relative(SRC, file)} -> ${m[1] ?? ""}`);
    }
  }
  assert.deepEqual(offenders, [], "the shipped catalog and the discovery mapping live in src/v2/runtime/model-catalog.ts alone");
});

test("single authority: only the catalog + provider adapter may build model entries", () => {
  // `ModelFactsInput` IS a catalog entry. Anything else handling one would be a second
  // way for a model to enter the inventory.
  const allowed = new Set([join(V2_DIR, "runtime", "model-catalog.ts"), join(V2_DIR, "runtime", "provider-inventory.ts"), join(V2_DIR, "core", "config.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/\bModelFactsInput\b/.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "catalog entries are produced by the catalog module and the provider adapter only");
});

test("single authority: the catalog module cannot even IMPORT a preference", () => {
  // Membership independence is structural: `CanonicalCatalogSources` has no field a
  // preference fits into, and this file imports nothing that could supply one — no
  // config singleton, no profile store, no operator defaults.
  const specs = importSpecifiers(readFileSync(join(V2_DIR, "runtime", "model-catalog.ts"), "utf8"));
  assert.deepEqual([...new Set(specs)].sort(), ["../core/config.js"], "the catalog module reads facts only");
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

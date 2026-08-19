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
  "../../core/injection/index.js", //              THE untrusted-data neutralization fence (V2-007A)
  "../../modules/worker-model/checks.js", //       deterministic check DISCOVERY (V2-008)
  "../../modules/governed-exec/index.js", //       THE governed check executor (V2-008) + builder terminal (V2-015)
  "../../modules/governed-exec/sandbox.js", //     command risk classification for the read-only terminal (V2-015)
  "../../core/identity/registry.js", //            self-contained verifier identity (V2-008)
  "../../core/identity/resolver.js", //            mint the verifier's OperationContext (V2-008)
  "../../core/identity/index.js", //               OperationContext type (V2-008)
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
  // `candidate-capture.ts` writes NOTHING in a repository: its only filesystem calls
  // create and remove a throwaway git index in the OS temp directory, so that staging a
  // candidate's tree never touches the worktree's own index. The next guard proves it
  // holds no repository write.
  // `publication.ts` writes a crash-durable promotion JOURNAL (intent/landed markers) under a
  // dedicated directory — never a repository or workspace file. It is the publication
  // authority's own audit trail, and the next guard proves it holds no candidate mutation.
  // `command-executor.ts` (V2-015) creates and removes a THROWAWAY OS temp directory (mkdtemp +
  // rm) to hand the sandbox a writable root that is NOT the candidate — exactly the same class as
  // candidate-capture's throwaway index. It writes NO repository or workspace file; the tree
  // before==after guard proves it, and the next guard proves it holds no candidate mutation.
  const allowed = new Set([
    join(V2_DIR, "runtime", "workspace-authority.ts"),
    join(V2_DIR, "runtime", "source-materializer.ts"),
    join(V2_DIR, "runtime", "candidate-capture.ts"),
    join(V2_DIR, "runtime", "publication.ts"),
    join(V2_DIR, "runtime", "command-executor.ts"),
  ]);
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
  // asking git what the working TREE looks like would be a second source reality.
  // `candidate-diff.ts` diffs two immutable TREE OBJECTS (start vs candidate) — it never
  // reads the working tree — so it is allowed to run `git diff <tree> <tree>`.
  // `command.ts` (V2-015) NAMES read-only git subcommands (status/diff/ls-files/…) in its policy
  // ALLOWLIST — it executes nothing and reads no working tree. Listing a permitted verb is not
  // capturing state; the command executor runs whatever the model passes through governed-exec.
  const allowed = new Set([join(V2_DIR, "runtime", "source-snapshot.ts"), join(V2_DIR, "runtime", "candidate-diff.ts"), join(V2_DIR, "core", "command.ts")]);
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

test("single authority: only the BUILDER CONTROLLER drives a candidate-generation loop", () => {
  // A second loop would be a second answer to "what counts as finished" and a second
  // place budgets are enforced — which is how a rescue path gets added quietly.
  const allowed = new Set([join(V2_DIR, "core", "builder.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/generateCandidate\s*\(|while\s*\(\s*turns|finish_candidate["']?\s*:/.test(source) && !file.endsWith("run.ts") && !file.endsWith("tools.ts")) {
      offenders.push(relative(SRC, file));
    }
  }
  assert.deepEqual(offenders, [], "the candidate-generation loop belongs to src/v2/core/builder.ts alone");
});

test("single authority: the BUILDER cannot import a filesystem, a provider, a resolver or the materializer", () => {
  // The controller is handed capability; it never holds it. This is the enforcement of
  // "the builder is not an authority over infrastructure".
  const file = join(V2_DIR, "core", "builder.ts");
  const specs = importSpecifiers(readFileSync(file, "utf8"));
  for (const forbidden of ["node:fs", "node:child_process", "node:path", "../runtime/source-materializer.js", "./source.js", "../../core/injection/index.js"]) {
    assert.equal(specs.includes(forbidden), false, `the builder must not import ${forbidden}; it imports: ${specs.join(", ")}`);
  }
  assert.equal(
    specs.some((spec) => spec.startsWith("node:")),
    false,
    "the builder controller performs no I/O of its own",
  );
  // It imports the resolver's DECISION TYPE — it has to name what it was authorized to
  // use — but it may never CHOOSE. A type is not a capability; a call is.
  const source = stripComments(readFileSync(file, "utf8"));
  assert.equal(/resolveModelRoute\s*\(|buildRuntimeModelPolicy\s*\(/.test(source), false, "the builder never resolves a model");
});

test("single authority: only the TOOL EXECUTOR writes candidate files, and it holds no fs", () => {
  // Every effect goes through StateBoundMutationAuthority.mutate. A `node:fs` import here
  // would be a path around the compare-and-swap.
  const file = join(V2_DIR, "runtime", "builder-tools.ts");
  const specs = importSpecifiers(readFileSync(file, "utf8"));
  assert.equal(
    specs.some((spec) => spec.startsWith("node:")),
    false,
    `the tool executor writes only through the mutation authority, but imports: ${specs.join(", ")}`,
  );
  const source = stripComments(readFileSync(file, "utf8"));
  assert.equal(/writeFileSync|readFileSync|rmSync|unlinkSync|mkdirSync/.test(source), false, "no raw filesystem call");
});

test("single authority: only the repair module mints a repair-brief identity (V2-013)", () => {
  const allowed = new Set([join(V2_DIR, "core", "repair.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/contentDigest\s*\(\s*"repair_brief/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "the repair-brief identity belongs to src/v2/core/repair.ts alone");
});

test("single authority: only the session controller EXTRACTS a repair brief (V2-013)", () => {
  // `buildRepairBrief` is called only by the session controller — AFTER the ONE recovery
  // authority decided a semantic-repair retry. The critic, verifier and builder can never
  // create one.
  const allowed = new Set([join(V2_DIR, "core", "session.ts"), join(V2_DIR, "core", "repair.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/buildRepairBrief\s*\(/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "no component extracts a repair brief on its own");
});

test("single authority: a semantic repair is AUTHORIZED only by the recovery decision (V2-013)", () => {
  // The session only extracts a brief when the recovery decision's mode is semantic_repair. The
  // decision is `decideRecovery`'s to make; the session reads `decision.mode` and does not invent
  // a repair on its own.
  const sessionSrc = stripComments(readFileSync(join(V2_DIR, "core", "session.ts"), "utf8"));
  assert.ok(/decision\.mode\s*===\s*"semantic_repair"/.test(sessionSrc), "the session extracts a brief only when recovery authorized a semantic repair");
});

test("single authority: the REPAIR BRIEF carries no reusable prior authority (V2-013)", () => {
  // The brief is bounded HISTORICAL evidence — never a live capability. It must not reference an
  // observation id, a mutation id, or a workspace path/id type that a new attempt could act on.
  const specs = importSpecifiers(readFileSync(join(V2_DIR, "core", "repair.ts"), "utf8"));
  for (const forbidden of ["V2ObservationDigest", "V2MutationDigest", "V2WorkspaceId", "./workspace"]) {
    assert.equal(specs.some((sp) => sp.includes(forbidden)), false, `repair.ts must not import ${forbidden}`);
  }
  const source = stripComments(readFileSync(join(V2_DIR, "core", "repair.ts"), "utf8"));
  assert.equal(/observationId|mutationId|workspacePath|workspaceId/.test(source), false, "the repair brief holds no reusable observation/mutation/workspace handle");
});

test("single authority: repair evidence crosses the untrusted boundary (V2-013)", () => {
  // Every free-text repair payload the model sees is fenced through the injected boundary.
  const source = stripComments(readFileSync(join(V2_DIR, "core", "repair.ts"), "utf8"));
  assert.ok(/boundary\.wrap\s*\(/.test(source), "renderRepairBrief wraps untrusted payloads through the boundary");
});

test("single authority: only the recovery module mints a recovery/policy identity (V2-012)", () => {
  const allowed = new Set([join(V2_DIR, "core", "recovery.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/contentDigest\s*\(\s*"recovery_decision|contentDigest\s*\(\s*"recovery_policy/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "the recovery decision + policy identity belong to src/v2/core/recovery.ts alone");
});

test("single authority: only the session controller decides a RETRY (V2-012)", () => {
  // `decideRecovery` is the ONLY thing that authorizes a new attempt; the session controller is
  // its only caller. A second caller would be a second retry path.
  const allowed = new Set([join(V2_DIR, "core", "session.ts"), join(V2_DIR, "core", "recovery.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/decideRecovery\s*\(/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "no component decides a retry on its own");
});

test("single authority: only the session controller mints a build-session identity and re-runs the spine (V2-012)", () => {
  // `mint("session")` and the loop that calls `runV2Build` more than once both belong to the
  // session controller. The single-run production entry calls it exactly once; nothing else may
  // create a second attempt.
  const sessionMinters: string[] = [];
  const spineCallers: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/mint\s*\(\s*["']session["']\s*\)/.test(source) && file !== join(V2_DIR, "core", "session.ts")) sessionMinters.push(relative(SRC, file));
    // `runV2Build(` may appear in run.ts (its declaration), session.ts (the attempt loop) and
    // runtime/index.ts (the single entry) — nowhere else may CALL the attempt spine.
    if (/\brunV2Build\s*\(/.test(source) && file !== join(V2_DIR, "core", "run.ts") && file !== join(V2_DIR, "core", "session.ts") && file !== join(V2_DIR, "runtime", "index.ts")) spineCallers.push(relative(SRC, file));
  }
  assert.deepEqual(sessionMinters, [], "only session.ts mints a build-session identity");
  assert.deepEqual(spineCallers, [], "only the session controller and the production entry invoke the attempt spine");
});

test("single authority: recovery + session import no v1 recovery/fix machinery (V2-012)", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (/modules\/recovery|worker-model\/(critic-recovery|critic-fix-loop|fix-recovery|fix-retry|fixer|escalation)/.test(spec)) {
        offenders.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "v2's recovery is rebuilt, not borrowed from v1's cascade/fix loops");
});

test("single authority: the RECOVERY decision is pure — it invokes/mutates/publishes nothing (V2-012)", () => {
  const source = stripComments(readFileSync(join(V2_DIR, "core", "recovery.ts"), "utf8"));
  const specs = importSpecifiers(readFileSync(join(V2_DIR, "core", "recovery.ts"), "utf8"));
  for (const forbidden of ["./invocation", "./builder", "./verification", "./promotion", "governed-exec", "runtime/"]) {
    assert.equal(specs.some((sp) => sp.includes(forbidden)), false, `recovery.ts must not import ${forbidden}`);
  }
  assert.equal(/runV2Build|invokeAuthorized|\.mutate\s*\(|\.publish\s*\(|process\.env/.test(source), false, "recovery.ts is a pure decision — no run, invoke, mutate, publish or env read");
});

test("single authority: the session controller FREEZES config — it reads no env or profile (V2-012)", () => {
  // The freeze is structural: an automatic attempt cannot re-read a profile or an env var,
  // because the session hands every attempt the SAME loaded configuration and touches neither.
  const source = stripComments(readFileSync(join(V2_DIR, "core", "session.ts"), "utf8"));
  assert.equal(/process\.env|activeProfile|IKBI_MODEL_/.test(source), false, "session.ts must not read env/profile between attempts");
  assert.ok(/attemptIdFactory/.test(source), "each attempt gets a fresh id factory (fresh RunId)");
});

test("single authority: only the promotion module mints a promotion identity (V2-011)", () => {
  const allowed = new Set([join(V2_DIR, "core", "promotion.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/contentDigest\s*\(\s*"promotion/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "the promotion identity belongs to src/v2/core/promotion.ts alone");
});

test("single authority: a candidate is PUBLISHED only by the run spine (V2-011)", () => {
  // `promotion.ts` declares `promoteAuthorized`; `run.ts` is the only caller. A second caller
  // would be a second publication path.
  const allowed = new Set([join(V2_DIR, "core", "run.ts"), join(V2_DIR, "core", "promotion.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/promoteAuthorized\s*\(/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "no component may publish on its own");
});

test("single authority: only the publication adapter moves a git ref (V2-011)", () => {
  // The clean-ref CAS lives in exactly ONE adapter. `updateRefCas` / `update-ref` anywhere
  // else in v2 would be a second, ungoverned way to move the target — the thing this slice
  // exists to make singular. `.promote(` (the v1 WorkspaceManager promote, which auto-merges)
  // must never be called from v2 at all.
  const allowed = new Set([join(V2_DIR, "runtime", "publication.ts")]);
  const refOffenders: string[] = [];
  const promoteOffenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (!allowed.has(file) && /updateRefCas\s*\(|["']update-ref["']/.test(source)) refOffenders.push(relative(SRC, file));
    if (/\.promote\s*\(/.test(source)) promoteOffenders.push(relative(SRC, file));
  }
  assert.deepEqual(refOffenders, [], "the target ref is moved only by src/v2/runtime/publication.ts");
  assert.deepEqual(promoteOffenders, [], "no v2 file calls the v1 auto-merging WorkspaceManager.promote");
});

test("single authority: the PROMOTION authority invokes no model, mutates no candidate, re-runs no verification (V2-011)", () => {
  // Publication is mechanical. `promotion.ts` (the pure authority) must not import the
  // invocation authority, the mutation authority, the builder, the critic, the verifier, a
  // check runner, or governed-exec, and must call none of them.
  // Type-only imports of the evidence records (VerificationRecord/CriticRecord/…) are
  // legitimate — the authority NAMES the evidence it enacts. What it must not import is the
  // MACHINERY that invokes, mutates or verifies; the content check below proves it calls none.
  const specs = importSpecifiers(readFileSync(join(V2_DIR, "core", "promotion.ts"), "utf8"));
  for (const forbidden of ["./invocation", "governed-exec", "./builder", "runtime/check-runner", "runtime/candidate-capture"]) {
    assert.equal(specs.some((sp) => sp.includes(forbidden)), false, `promotion.ts must not import ${forbidden}`);
  }
  const source = stripComments(readFileSync(join(V2_DIR, "core", "promotion.ts"), "utf8"));
  assert.equal(/invokeAuthorized|judgeCandidate|judgeDisposition|\.mutate\s*\(|verifyCandidate/.test(source), false, "promotion.ts must not invoke, judge, mutate or verify");
});

test("single authority: promotion is downstream of disposition — earlier authorities cannot import it (V2-011)", () => {
  // The disposition decides eligibility; the builder/critic/verifier produce evidence. None of
  // them may reach the publication authority — promotion is strictly the spine's final act.
  const forbiddenImporters = ["disposition.ts", "builder.ts", "critic.ts", "verification.ts"].map((f) => join(V2_DIR, "core", f));
  const offenders: string[] = [];
  for (const file of forbiddenImporters) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (/\/promotion(\.js)?$/.test(spec) || spec.includes("runtime/publication")) offenders.push(`${relative(SRC, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "no earlier authority imports the promotion/publication modules");
});

test("single authority: only the disposition module mints a disposition identity (V2-010)", () => {
  const allowed = new Set([join(V2_DIR, "core", "disposition.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/contentDigest\s*\(\s*"disposition/.test(source)) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "the disposition + policy identity belong to src/v2/core/disposition.ts alone");
});

test("single authority: a candidate is ADJUDICATED only by the run spine (V2-010)", () => {
  // `disposition.ts` declares `judgeDisposition`; `run.ts` is the only caller. A second
  // caller would be a second adjudication path.
  const allowed = new Set([join(V2_DIR, "core", "run.ts"), join(V2_DIR, "core", "disposition.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/judgeDisposition\s*\(/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "no component may adjudicate on its own");
});

test("single authority: the DISPOSITION neither mutates, invokes, verifies, promotes nor repairs (V2-010)", () => {
  // Pure adjudication: it reads evidence + policy and returns a decision. Type-only imports of
  // the evidence records (CriticRecord/VerificationRecord/CandidateRecord) are legitimate — it
  // NAMES the evidence it judges. What it must not import is the MACHINERY that invokes,
  // mutates, verifies, promotes or repairs; the content check below proves it calls none of it.
  const specs = importSpecifiers(readFileSync(join(V2_DIR, "core", "disposition.ts"), "utf8"));
  for (const forbidden of ["./invocation", "governed-exec", "./builder", "runtime/check-runner", "runtime/candidate-capture", "./promotion", "./recovery"]) {
    assert.equal(specs.some((sp) => sp.includes(forbidden)), false, `disposition.ts must not import ${forbidden}`);
  }
  const source = stripComments(readFileSync(join(V2_DIR, "core", "disposition.ts"), "utf8"));
  assert.equal(/\.mutate\s*\(|invokeAuthorized|judgeCandidate|writeFileSync|execFile|spawn\s*\(|\.promote\s*\(|update-ref/.test(source), false, "disposition.ts must not mutate, invoke, verify, promote or spawn");
});

test("single authority: the disposition module enacts NO promotion and NO git ref move (V2-010)", () => {
  // `eligibleForPromotion=true` is an AUTHORIZATION fact. The disposition module must contain
  // no promotion mechanics whatsoever — no ref update, no merge, no commit, no promote call.
  const source = stripComments(readFileSync(join(V2_DIR, "core", "disposition.ts"), "utf8"));
  assert.equal(/update-ref|git\s+merge|git\s+commit|WorkspaceManager|\.promote\b/.test(source), false, "no promotion side effect lives in the adjudication authority");
});

test("single authority: no v2 file imports a v1 integrator / adjudication / refuter (V2-010)", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (/worker-model\/(integrator|adjudication|refuter|critic-fix-loop)/.test(spec)) {
        offenders.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "v2's disposition is rebuilt, not borrowed from v1's integrator/adjudication blob");
});

test("single authority: the disposition flags are DERIVED, never independently set (V2-010)", () => {
  // The three secondary facts must be produced only by `deriveDispositionFlags`; no other v2
  // code may assemble a DispositionRecord by writing `eligibleForPromotion:` etc. directly.
  // Confining the derivation to disposition.ts is what makes an impossible flag combination
  // unconstructable. `promotion.ts` is exempt: it does not DERIVE the flag, it READS it FROM
  // the disposition record to prove publication is authorized — the assertion below pins that.
  const promotionSrc = stripComments(readFileSync(join(V2_DIR, "core", "promotion.ts"), "utf8"));
  assert.ok(/input\.disposition\.eligibleForPromotion/.test(promotionSrc), "promotion.ts copies the eligibility fact FROM the disposition, never invents it");
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts") || file === join(V2_DIR, "core", "disposition.ts") || file === join(V2_DIR, "core", "promotion.ts")) continue;
    if (/eligibleForPromotion\s*:/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "only disposition.ts writes the derived promotion-eligibility flag");
});

test("single authority: only the critic module mints a critic/defect identity (V2-009)", () => {
  const allowed = new Set([join(V2_DIR, "core", "critic.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/contentDigest\s*\(\s*"critic|contentDigest\s*\(\s*"defect/.test(source)) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "critic + defect identity belong to src/v2/core/critic.ts alone");
});

test("single authority: a candidate is JUDGED only by the run spine (V2-009)", () => {
  // `critic.ts` declares `judgeCandidate`; `run.ts` is the only caller. A second caller
  // would be a second semantic-review path.
  const allowed = new Set([join(V2_DIR, "core", "run.ts"), join(V2_DIR, "core", "critic.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/judgeCandidate\s*\(/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "no component may run the critic on its own");
});

test("single authority: the CRITIC neither mutates, verifies, nor holds a tool (V2-009)", () => {
  // Deterministic-evidence separation: the critic reads a review package and returns a
  // judgment. It must not import the mutation authority, governed-exec, the builder tools,
  // a check runner, or any disposition/promotion — and it invokes only through the one
  // invocation authority.
  const criticFiles = [join(V2_DIR, "core", "critic.ts"), join(V2_DIR, "core", "critic-review.ts")];
  for (const file of criticFiles) {
    const specs = importSpecifiers(readFileSync(file, "utf8"));
    for (const forbidden of ["governed-exec", "./builder-tools", "runtime/check-runner", "runtime/candidate-capture"]) {
      assert.equal(specs.some((sp) => sp.includes(forbidden)), false, `${relative(SRC, file)} must not import ${forbidden}`);
    }
    const source = stripComments(readFileSync(file, "utf8"));
    assert.equal(/\.mutate\s*\(|verifyCandidate|writeFileSync|execFile|spawn\s*\(/.test(source), false, `${relative(SRC, file)} must not mutate, verify or spawn`);
  }
});

test("single authority: no v2 file imports a v1 critic / refuter / integrator / semantic judge (V2-009)", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (/worker-model\/(critic|refuter|integrator|critic-fix-loop|semantic-verdict|semantic-evidence|deterministic-judge)/.test(spec)) {
        offenders.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "v2's critic is rebuilt, not borrowed — and no bare PASS/FAIL parser is imported");
});

test("single authority: critic input crosses the untrusted boundary (V2-009)", () => {
  // The critic's review render must wrap its untrusted payloads (goal, diff, check output,
  // builder claim) through the injected boundary — never raw-concatenate them.
  const source = stripComments(readFileSync(join(V2_DIR, "core", "critic-review.ts"), "utf8"));
  assert.ok(/boundary\.wrap\s*\(/.test(source), "the review render wraps untrusted payloads through the boundary");
});

test("single authority: consumers request a model decision BY ROLE, never by array position (V2-009)", () => {
  // Multi-role resolution: the critic must resolve its OWN decision (role: "critic"), not
  // borrow the builder's. A `role: "critic"` request appears; no code indexes a decisions
  // array positionally to pick a role.
  const runSource = stripComments(readFileSync(join(V2_DIR, "core", "run.ts"), "utf8"));
  assert.ok(/role:\s*["']critic["']/.test(runSource), "the critic route is resolved as its own role request");
  assert.ok(/role:\s*DEMONSTRATED_ROLE|role:\s*["']builder["']/.test(runSource), "the builder route is resolved as its own role request");
});

test("single chokepoint: only the boundary adapter imports v1 neutralization (V2-007A)", () => {
  // Untrusted content is wrapped in exactly one place. A second importer of
  // neutralizeUntrusted would be a second, divergent neutralization policy.
  const allowed = new Set([join(V2_DIR, "runtime", "untrusted-boundary.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.includes("core/injection")) offenders.push(`${relative(SRC, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "the neutralization fence is reached through the injected boundary alone");
});

test("single chokepoint: only the builder controller appends a tool-role message (V2-007A)", () => {
  // Every ToolExecutionResult becomes a conversation message in ONE function. A tool that
  // constructed its own `role: "tool"` message would bypass the neutralization boundary.
  const allowed = new Set([join(V2_DIR, "core", "builder.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/role:\s*["']tool["']/.test(source)) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "tool-role messages are appended only by the builder's one chokepoint");
});

test("single chokepoint: repository-derived tool payload is consumed only by the chokepoint (V2-007A)", () => {
  // `untrustedToolPayload` is the ONLY source of repository/tool-derived free text destined
  // for the conversation. `tools.ts` declares it; only `builder.ts` may consume it, and it
  // does so by wrapping through the boundary. Anywhere else would be a second, un-fenced path.
  const allowed = new Set([join(V2_DIR, "core", "tools.ts"), join(V2_DIR, "core", "builder.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/untrustedToolPayload\s*\(/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "untrusted tool payload never reaches the conversation through another path");
});

test("single chokepoint: the tool executor builds NO conversation message (V2-007A)", () => {
  // The executor returns a structured ToolExecutionResult; turning it into a message —
  // and neutralizing it — is the builder's job. The executor must not touch prompt shapes.
  const source = stripComments(readFileSync(join(V2_DIR, "runtime", "builder-tools.ts"), "utf8"));
  assert.equal(/RenderedMessage|renderBuilderInput|role:\s*["'](tool|system|assistant)["']/.test(source), false, "the executor produces results, not messages");
});

test("single authority: the builder terminal is STRUCTURED ARGV, never a SHELL (V2-015)", () => {
  // V2-015 gives the builder a READ-ONLY terminal — but it is argv-only. `sed -i` / `echo >`
  // write only through a shell, and there is none: no v2 file may set `shell: true`, spawn a
  // shell (`sh`/`bash`/`zsh`/`dash` with `-c`), or use the string-command `child_process.exec`.
  // Commands are program + args[], handed literally to governed-exec, so >, |, &&, ; and $()
  // are never interpreted.
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts") || file.endsWith("fixture-repo.ts") || file.endsWith("fake-provider-server.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    const rel = relative(SRC, file);
    if (/\bshell\s*:\s*true\b/.test(source)) offenders.push(`${rel} (shell:true)`);
    if (/["'](sh|bash|zsh|dash|ksh|fish)["']\s*,\s*["']-c["']/.test(source)) offenders.push(`${rel} (shell -c)`);
    // The string-command exec forms (execSync("…"), child_process.exec("…")) — NOT execFile.
    if (/\bexecSync\s*\(|[^A-Za-z]exec\s*\(\s*["'`]/.test(source)) offenders.push(`${rel} (string exec)`);
  }
  assert.deepEqual(offenders, [], "v2 executes structured argv only — no shell, anywhere");
});

test("single authority: the READ-ONLY terminal never mints an observation or holds mutation authority (V2-015)", () => {
  // A command may INSPECT the workspace, never change it. The command files must not reach the
  // state-bound mutation authority and must not mint an observation — to edit a file the model
  // must still call read_file (which mints the observation) and a state-bound write. This keeps
  // terminal execution from becoming a second mutation path.
  const commandFiles = [join(V2_DIR, "core", "command.ts"), join(V2_DIR, "runtime", "command-executor.ts")];
  for (const file of commandFiles) {
    const source = stripComments(readFileSync(file, "utf8"));
    const rel = relative(SRC, file);
    assert.equal(/StateBoundMutationAuthority|\.mutate\s*\(|mutations\s*\./.test(source), false, `${rel} must not reach the mutation authority`);
    assert.equal(/contentDigest\s*\(\s*["']observation|mintObservation|\.read\s*\(\s*\{/.test(source), false, `${rel} must not mint an observation`);
  }
});

test("single authority: the model command path can NEVER set verifier:true (V2-015)", () => {
  // `verifier: true` authorizes package SCRIPTS (pnpm test). It is the verifier's alone. The
  // builder command executor must pass verifier:false and never the literal true, so command
  // TEXT can never grant script-execution authority.
  const source = stripComments(readFileSync(join(V2_DIR, "runtime", "command-executor.ts"), "utf8"));
  assert.equal(/verifier\s*:\s*true/.test(source), false, "the builder terminal must never set verifier:true");
  assert.ok(/verifier\s*:\s*false/.test(source), "the builder terminal must explicitly pass verifier:false");
});

test("single authority: only the candidate module mints a candidate identity", () => {
  const allowed = new Set([join(V2_DIR, "core", "candidate.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/contentDigest\s*\(\s*"candidate"/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "candidate identity belongs to src/v2/core/candidate.ts");
});

test("single authority: a candidate is CREATED only by the run spine, after generation", () => {
  // `candidate.ts` declares the function; `run.ts` is the only caller.
  const allowed = new Set([join(V2_DIR, "core", "run.ts"), join(V2_DIR, "core", "candidate.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/candidateDigest\s*\(/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "no component may declare a candidate into existence on its own");
});

test("single authority: only the verification module mints a verification identity (V2-008)", () => {
  const allowed = new Set([join(V2_DIR, "core", "verification.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/contentDigest\s*\(\s*"verification/.test(source)) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "verification + plan identity belong to src/v2/core/verification.ts alone");
});

test("single authority: a candidate is VERIFIED only by the run spine (V2-008)", () => {
  // `verification.ts` declares `verifyCandidate`; `run.ts` is the only caller. A second
  // caller would be a second verification path — the thing this authority exists to prevent.
  const allowed = new Set([join(V2_DIR, "core", "run.ts"), join(V2_DIR, "core", "verification.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/verifyCandidate\s*\(/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "no component may run verification on its own");
});

test("single authority: only the two enumerated adapters reach governed-exec (V2-008, V2-015)", () => {
  // Governed execution has exactly TWO callers, each a narrow adapter: the check-runner (the
  // VERIFIER's predeclared plan, verifier:true — the model never reaches it) and the builder
  // command executor (the READ-ONLY terminal, verifier:false — a model requests a bounded,
  // structured, read-only command). Any THIRD importer would be an ungoverned execution path.
  const allowed = new Set([join(V2_DIR, "runtime", "check-runner.ts"), join(V2_DIR, "runtime", "command-executor.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.includes("governed-exec")) offenders.push(`${relative(SRC, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "governed execution is reached through the check-runner and command-executor adapters alone");
});

test("single authority: no v2 file spawns a process for verification outside the adapter (V2-008)", () => {
  // The check-runner adapter is the ONLY place a check command is executed. A stray
  // child_process spawn/exec would be an ungoverned check path.
  const allowed = new Set([join(V2_DIR, "runtime", "check-runner.ts"), join(V2_DIR, "runtime", "source-snapshot.ts"), join(V2_DIR, "runtime", "candidate-capture.ts"), join(V2_DIR, "runtime", "workspace-authority.ts"), join(V2_DIR, "runtime", "source-materializer.ts"), join(V2_DIR, "runtime", "verification-tree.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts") || file.endsWith("fixture-repo.ts") || file.endsWith("fake-provider-server.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/child_process|execFileSync|spawnSync|\bspawn\s*\(/.test(source)) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "verification never spawns a process outside the governed check-runner adapter");
});

test("single authority: the verifier neither mutates nor invokes a model (V2-008)", () => {
  // Deterministic verification only: no StateBoundMutationAuthority.mutate, no
  // InvocationAuthority, no critic/refuter/integrator/judge/fixer. The core verifier
  // imports only pure contracts.
  const specs = importSpecifiers(readFileSync(join(V2_DIR, "core", "verification.ts"), "utf8"));
  for (const forbidden of ["./invocation.js", "./builder.js", "node:fs", "node:child_process"]) {
    assert.equal(specs.includes(forbidden), false, `the verifier must not import ${forbidden}`);
  }
  const source = stripComments(readFileSync(join(V2_DIR, "core", "verification.ts"), "utf8"));
  assert.equal(/\.mutate\s*\(|invokeAuthorized|generateCandidate/.test(source), false, "the verifier does not mutate or invoke a model");
  // And nothing in v2 imports a v1 critic / refuter / integrator / judge / fixer.
  const critics: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (/worker-model\/(critic|refuter|integrator|fix|deterministic-judge|verifier)\b|semantic-judge/.test(spec)) critics.push(`${relative(SRC, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(critics, [], "V2-008 is deterministic — no critic/refuter/integrator/judge/fixer/verifier v1 import");
});

test("single authority: no v2 file imports the v1 BUILDER or its tools", () => {
  // v1's builder is 2327 lines of loop AND policy — auto-accept on green checks, stuck
  // detection, text-protocol emulation. Importing any of it would import that policy.
  const forbidden = [
    "worker-model/builder.js",
    "worker-model/tool-executor.js",
    "worker-model/builder-tools/",
    "worker-model/context-manager.js",
    "worker-model/orchestrator.js",
    "worker-model/tournament.js",
  ];
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (forbidden.some((f) => spec.includes(f))) offenders.push(`${relative(SRC, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "v2's builder is rebuilt, not borrowed");
});

test("single authority: TOOL SCHEMAS are declared in exactly one place", () => {
  const allowed = new Set([join(V2_DIR, "core", "tools.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/BUILDER_TOOLS\s*[:=]|additionalProperties/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "a second tool schema is a second contract with the model");
});

test("single authority: no v2 file parses tool calls out of PROSE", () => {
  // v1 emulates tool calls by regexing markdown for models without a tool API. That path
  // can execute a "call" the model never made; v2 uses provider-native calls only.
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/parseTextToolCalls|text-tool-protocol|emulateTools/.test(source)) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "tool intent is never inferred from text in v2");
});

test("single authority: only the retrieval module RANKS repository relevance", () => {
  // Retrieval discovers; context admits. A second place computing relevance would mean
  // two silent opinions about what the builder should see.
  const allowed = new Set([join(V2_DIR, "core", "retrieval.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (/REASON_WEIGHT|\bscore\s*[:=+]|rankFiles\s*=|function\s+rank/.test(source)) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "relevance scoring belongs to src/v2/core/retrieval.ts alone");
});

test("single authority: the retrieval SOURCE ranks nothing and re-sorts nothing", () => {
  // It reads bytes and converts a ranking into candidates. Sorting here would be a
  // second ranking that no test of `rankFiles` could ever catch.
  const source = stripComments(readFileSync(join(V2_DIR, "runtime", "retrieval-source.ts"), "utf8"));
  assert.equal(/\.sort\s*\(/.test(source), false, "the retrieval source must not impose an order of its own");
  assert.equal(/contentDigest\s*\(/.test(source), false, "retrieval identity is minted in core, not in the adapter");
});

test("single authority: retrieval enumerates source ONLY through the snapshot reader", () => {
  // No `node:fs`, no `git ls-files`, no `find`, no ripgrep. A file created after capture
  // is not part of this run's source and must not become discoverable.
  const file = join(V2_DIR, "runtime", "retrieval-source.ts");
  const specs = importSpecifiers(readFileSync(file, "utf8"));
  assert.equal(
    specs.some((spec) => spec.startsWith("node:")),
    false,
    `retrieval reads through the snapshot only, but imports: ${specs.join(", ")}`,
  );
  const source = stripComments(readFileSync(file, "utf8"));
  assert.equal(/readdir|readFileSync|execFile|spawn|ripgrep|ls-files/.test(source), false, "retrieval must not walk a filesystem");
});

test("single authority: only the retrieval module mints a retrieval identity", () => {
  const allowed = new Set([join(V2_DIR, "core", "retrieval.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/contentDigest\s*\(\s*"retrieval"/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "retrieval identity belongs to src/v2/core/retrieval.ts");
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
      // Scoped to the v1 paths: v2 has its own `runtime/builder-tools.ts`, which IS the
      // sanctioned executor and writes only through the adopted core.
      if (/mutation-session|repair-plan|worker-model\/builder-tools|worker-model\/tool-executor/.test(spec)) {
        offenders.push(`${relative(SRC, file)} -> ${spec}`);
      }
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
  // `./tools.js` is TYPES ONLY (`BuilderToolCall`): a rendered assistant turn has to be
  // able to carry the calls the model made, or the tool loop cannot round-trip. It is not
  // a way to reach a repository, which is what this guard is about.
  // V2-013: `./repair.js` (the repair-brief renderer + system note) and `./builder.js` (the
  // `UntrustedBoundary` type) are added — neither reaches a repository reader; the repair brief
  // is bounded historical evidence and is fenced through the boundary.
  const specs = importSpecifiers(readFileSync(join(V2_DIR, "core", "prompt.ts"), "utf8"));
  assert.deepEqual([...new Set(specs)].sort(), ["./builder.js", "./context.js", "./identity.js", "./repair.js", "./tools.js"], "the renderer reads the authorized package + neutralized repair evidence only");
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
  // `retrieval-source.ts` joins the list because it IS one of the production sources —
  // the guard is about who may HOLD the list, not about how many sources exist.
  const allowed = new Set([join(V2_DIR, "runtime", "context-sources.ts"), join(V2_DIR, "runtime", "retrieval-source.ts"), join(V2_DIR, "runtime", "index.ts"), join(V2_DIR, "core", "context.ts"), join(V2_DIR, "core", "run.ts"), join(V2_DIR, "cli", "index.ts")]);
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

// ---------------------------------------------------------------------------
// V2-014 — SINGLE COST / ACCOUNTING AUTHORITY
// ---------------------------------------------------------------------------

test("single authority: only the cost module defines per-token pricing rates", () => {
  // A second place defining `*PerMillion*` rates is how a shadow pricing table would fork the
  // one accounting truth. There is exactly one, in src/v2/core/cost.ts.
  const costFile = join(V2_DIR, "core", "cost.ts");
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (file === costFile || file.endsWith(".test.ts")) continue;
    if (/PerMillion/.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "token pricing rates live in src/v2/core/cost.ts alone");
});

test("single authority: the budget authority does not resolve or select models", () => {
  // Budget is governance, not selection. The cost module must not import the resolver, the
  // inventory catalog, the profile source or operator defaults — anything it could use to
  // choose or downgrade a model. It prices and admits; it never picks.
  const specs = new Set(importSpecifiers(readFileSync(join(V2_DIR, "core", "cost.ts"), "utf8")));
  for (const forbidden of ["./resolver.js", "../runtime/model-catalog.js", "./context.js", "./prompt.js"]) {
    assert.ok(!specs.has(forbidden), `the cost module must not import ${forbidden} — budget is not model selection`);
  }
});

test("single authority: the resolver does not inspect the cost/budget module", () => {
  // Model selection must not read a budget. The resolver stays a pure selection authority.
  const specs = new Set(importSpecifiers(readFileSync(join(V2_DIR, "core", "resolver.ts"), "utf8")));
  assert.ok(!specs.has("./cost.js"), "the resolver must not import the cost/budget module");
});

test("single authority: nothing outside the invocation authority reads provider usage into cost", () => {
  // Cost is derived ONLY from V2InvocationRecord.usage (the invocation authority's observed
  // fact). No other v2 module may synthesize an `ObservedUsage` to feed accounting.
  const allowed = new Set([join(V2_DIR, "core", "cost.ts"), join(V2_DIR, "core", "invocation.ts"), join(V2_DIR, "runtime", "invocation-transport.ts"), join(V2_DIR, "core", "result.ts")]);
  const offenders: string[] = [];
  for (const file of tsFiles(V2_DIR)) {
    if (allowed.has(file) || file.endsWith(".test.ts")) continue;
    if (/\bObservedUsage\b/.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "observed usage flows from the invocation authority into cost, nowhere else");
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

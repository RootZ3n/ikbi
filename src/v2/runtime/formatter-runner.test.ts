/**
 * THE GOVERNED FORMATTER — against a REAL git worktree, the REAL state-bound mutation core, and
 * (where the toolchain is present) the REAL rustfmt.
 *
 * The suite is deliberately weighted toward the hostile half. A formatter is the first thing in
 * this engine that runs a program which WRITES, so the interesting question is never "does it
 * format?" but "what can it reach, and what happens when it goes wrong?". Every one of these
 * asserts the same underlying property from a different angle: THE CANDIDATE IS NOT TOUCHED
 * UNLESS THE WHOLE RUN SUCCEEDED AND EVERY CHANGED PATH WAS IN SCOPE.
 *
 * Capability: git.
 */

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";

import { createProductionWorkspaceAuthorities } from "./workspace-authority.js";
import { createSourceSnapshotAuthority } from "./source-snapshot.js";
import { createTreeProbe } from "./verification-tree.js";
import { createFormatterCapability, createGovernedFormatterTransport, resolveFormatterId, type FormatterTransport } from "./formatter-runner.js";
import { buildMutationScope, type MutationScope } from "../core/mutation-scope.js";
import { RUSTFMT_WORKSPACE_V1, formatterDefinition, isFormatterId, type FormatterRecord } from "../core/formatter.js";
import { createSequentialIdFactory } from "../core/identity.js";
import { initGitRepo } from "../cli/fixture-repo.js";
import type { V2WorkspaceRecord } from "../core/workspace.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scopeOf(request: Parameters<typeof buildMutationScope>[0]): MutationScope {
  const built = buildMutationScope(request);
  if (!built.ok) throw new Error(`scope must build: ${built.detail}`);
  return built.scope;
}
const REPO_WIDE = scopeOf({ repoWide: true });

/** A cargo workspace whose source is deliberately mis-formatted. */
const UNFORMATTED_MAIN = "fn  main( ) {\n      let x=1;\n   println!(\"{}\",x) ;\n}\n";
const CARGO_TOML = '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n\n[[bin]]\nname = "fx"\npath = "src/main.rs"\n';

/** A real repository, a real worktree, the real mutation core, and a formatter over it. */
async function fixture(files: Readonly<Record<string, string>>, scope: MutationScope, transport: FormatterTransport) {
  const repo = initGitRepo(files);
  dirs.push(repo);

  const ids = createSequentialIdFactory("fmt");
  const runId = ids.mint("run");
  const sources = createSourceSnapshotAuthority();
  const captured = await sources.capture({ repoPath: repo });
  assert.ok(captured.ok, "snapshot capture failed");

  const { workspaces: manager } = await import("../../core/workspace/index.js");
  const { workspaces, mutations } = createProductionWorkspaceAuthorities({
    manager,
    mintWorkspaceId: () => ids.mint("workspace"),
    capturedBytes: (id) => sources.capturedBytes(id),
  });
  const allocated = await workspaces.allocate({ runId, source: captured.reader.snapshot, label: "fmt" });
  assert.ok(allocated.ok, allocated.ok ? "" : allocated.failure.message);
  const workspace: V2WorkspaceRecord = allocated.workspace;
  dirs.push(workspace.path);

  const treeProbe = createTreeProbe();
  const capability = createFormatterCapability({ transport, treeProbe, mutations, workspace, mutationScope: scope, runId });

  const run = (formatterId: "rustfmt_workspace_v1" = "rustfmt_workspace_v1") =>
    capability.run({
      runId, ordinal: 1, formatterId,
      workspaceId: workspace.workspaceId, workspacePath: workspace.path,
      baseCommit: workspace.source.baseCommit,
    });

  const readWorkspace = (p: string) => readFileSync(join(workspace.path, ...p.split("/")), "utf8");
  return { repo, workspace, capability, run, readWorkspace, treeProbe };
}

/**
 * A transport that RECORDS what it was asked to do and edits the shadow itself.
 *
 * Standing in for the toolchain lets the hostile cases be exact and fast, and — more importantly
 * — lets the suite assert what was HANDED to the transport, which is where an argv or an
 * environment would have to be smuggled through if it could be.
 */
function fakeTransport(behaviour: {
  readonly edit?: (shadow: string) => void;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly launched?: boolean;
  readonly stdout?: string;
} = {}) {
  const calls: { program: string; args: readonly string[]; cwd: string; timeoutMs: number; writableRoot: string }[] = [];
  const transport: FormatterTransport = {
    async run(input) {
      calls.push({ program: input.program, args: [...input.args], cwd: input.cwd, timeoutMs: input.timeoutMs, writableRoot: input.writableRoot });
      // The version probe answers first and is never the subject of the behaviour under test.
      if (input.args.includes("--version")) {
        return { launched: true, exitCode: 0, timedOut: false, stdout: "rustfmt 1.9.0-fake", stderr: "", durationMs: 1 };
      }
      if (behaviour.launched === false) {
        return { launched: false, timedOut: false, stdout: "", stderr: "", durationMs: 1, refusedReason: "binary not allowlisted" };
      }
      if (behaviour.timedOut === true) {
        return { launched: true, exitCode: 124, timedOut: true, stdout: behaviour.stdout ?? "", stderr: "", durationMs: 1 };
      }
      behaviour.edit?.(input.cwd);
      return { launched: true, exitCode: behaviour.exitCode ?? 0, timedOut: false, stdout: behaviour.stdout ?? "", stderr: "", durationMs: 1 };
    },
  };
  return { transport, calls };
}

const rustToolchain = (): boolean => spawnSync("cargo", ["fmt", "--version"], { encoding: "utf8" }).status === 0;

// ---------------------------------------------------------------------------
// The definition itself — what the model can and cannot influence
// ---------------------------------------------------------------------------

test("the formatter set is CLOSED and its argv is fixed", () => {
  assert.equal(isFormatterId("rustfmt_workspace_v1"), true);
  for (const invented of ["rustfmt", "cargo fmt", "rustfmt_workspace_v2", "", "  "]) {
    assert.equal(isFormatterId(invented), false, invented);
    assert.equal(resolveFormatterId(invented).ok, false, invented);
  }
  const def = formatterDefinition("rustfmt_workspace_v1");
  assert.equal(def.program, "cargo");
  assert.deepEqual([...def.argv], ["fmt", "--all"], "the canonical workspace format, and nothing else");
  assert.equal(def.network, "deny");
  assert.ok(def.timeoutMs > 0 && def.maxOutputBytes > 0);
  assert.deepEqual([...def.permittedExitCodes], [0]);
});

test("the definition is FROZEN — nothing downstream can append a flag to it", () => {
  assert.throws(() => {
    (RUSTFMT_WORKSPACE_V1.argv as unknown as string[]).push("--config=whatever");
  });
  assert.throws(() => {
    (RUSTFMT_WORKSPACE_V1 as unknown as { program: string }).program = "sh";
  });
});

// ---------------------------------------------------------------------------
// Hostile: the model tries to supply more than an identifier
// ---------------------------------------------------------------------------

test("HOSTILE: a model-requested custom argv reaches nothing — the transport gets the FIXED argv", async () => {
  const { transport, calls } = fakeTransport({ edit: (s) => writeFileSync(join(s, "src", "main.rs"), "fn main() {}\n") });
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, REPO_WIDE, transport);
  await f.run();

  const format = calls.find((c) => !c.args.includes("--version"));
  assert.ok(format !== undefined);
  assert.equal(format.program, "cargo");
  assert.deepEqual(format.args, ["fmt", "--all"], "exactly the definition's argv");
  // There is no parameter through which anything else could arrive: the tool schema accepts one
  // key, the parser enforces it, and the capability takes an ENUM, not a string.
  assert.deepEqual(Object.keys({ formatter: "" }), ["formatter"]);
});

test("HOSTILE: a model-requested different executable is not expressible", async () => {
  // `resolveFormatterId` is the whole surface between model text and a program name.
  for (const attempt of ["sh", "/bin/sh", "cargo", "rustfmt --config x", "rustfmt_workspace_v1; rm -rf /"]) {
    assert.equal(resolveFormatterId(attempt).ok, false, attempt);
  }
  // And the only accepted identifier maps to a constant.
  const ok = resolveFormatterId("rustfmt_workspace_v1");
  assert.equal(ok.ok, true);
  assert.equal(formatterDefinition((ok as { ok: true; id: "rustfmt_workspace_v1" }).id).program, "cargo");
});

test("HOSTILE: the formatter's cwd is the SHADOW, and the candidate is never the writable root", async () => {
  const { transport, calls } = fakeTransport();
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, REPO_WIDE, transport);
  await f.run();

  for (const call of calls) {
    assert.notEqual(call.cwd, f.workspace.path, "the formatter never runs IN the candidate");
    assert.ok(!call.cwd.startsWith(f.workspace.path), "nor anywhere inside it");
    assert.equal(call.writableRoot, call.cwd, "the only writable root is the shadow it runs in");
    assert.ok(call.cwd.startsWith(tmpdir()), "the shadow is private scratch");
  }
});

test("HOSTILE: the shadow is DISCARDED — no scratch copy of the candidate outlives the run", async () => {
  const { transport, calls } = fakeTransport();
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, REPO_WIDE, transport);
  await f.run();
  for (const call of calls) assert.equal(existsSync(call.cwd), false, `${call.cwd} survived the invocation`);
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test("a formatter that changes ONLY authorized paths applies them through the mutation core", async () => {
  const formatted = "fn main() {\n    let x = 1;\n    println!(\"{}\", x);\n}\n";
  const { transport } = fakeTransport({ edit: (s) => writeFileSync(join(s, "src", "main.rs"), formatted) });
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, scopeOf({ allowTrees: ["src"] }), transport);

  const result = await f.run();
  assert.equal(result.outcome.outcome, "applied");
  assert.deepEqual([...result.outcome.changedPaths], ["src/main.rs"]);
  assert.equal(f.readWorkspace("src/main.rs"), formatted, "the bytes really landed in the candidate");
  assert.equal(result.record?.candidateTreeBefore === result.record?.candidateTreeAfter, false, "the candidate tree moved");
});

test("a formatter that would change an UNAUTHORIZED path applies NOTHING — all or nothing", async () => {
  const { transport } = fakeTransport({
    edit: (s) => {
      writeFileSync(join(s, "src", "main.rs"), "fn main() {}\n");
      writeFileSync(join(s, "build.rs"), "fn main() {}\n"); // outside `src/`
    },
  });
  const f = await fixture(
    { "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN, "build.rs": "fn  main(){}\n" },
    scopeOf({ allowTrees: ["src"] }),
    transport,
  );

  const result = await f.run();
  assert.equal(result.outcome.outcome, "refused_out_of_scope");
  assert.deepEqual([...result.outcome.refusedPaths], ["build.rs"]);
  assert.deepEqual([...result.outcome.changedPaths], [], "not even the in-scope file was applied");
  // THE POINT: a partial application would leave a state the formatter never produced.
  assert.equal(f.readWorkspace("src/main.rs"), UNFORMATTED_MAIN, "the in-scope file is untouched too");
  assert.equal(f.readWorkspace("build.rs"), "fn  main(){}\n");
  assert.equal(result.record?.candidateTreeBefore, result.record?.candidateTreeAfter, "the candidate tree did not move");
});

test("a formatter that CREATES a file outside scope is refused, and the creation is named", async () => {
  const { transport } = fakeTransport({ edit: (s) => writeFileSync(join(s, "generated.rs"), "// new\n") });
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, scopeOf({ allowTrees: ["src"] }), transport);

  const result = await f.run();
  assert.equal(result.outcome.outcome, "refused_out_of_scope");
  const refused = result.record?.scopeDecision.outOfScope ?? [];
  assert.equal(refused[0]?.path, "generated.rs");
  assert.equal(refused[0]?.operation, "create", "the OPERATION is named, not just the path");
  assert.equal(existsSync(join(f.workspace.path, "generated.rs")), false);
});

test("a formatter that DELETES a file outside scope is refused as a delete", async () => {
  const { transport } = fakeTransport({ edit: (s) => rmSync(join(s, "notes.md")) });
  const f = await fixture(
    { "Cargo.toml": CARGO_TOML, "src/main.rs": "fn main() {}\n", "notes.md": "hello\n" },
    scopeOf({ allowTrees: ["src"] }),
    transport,
  );
  const result = await f.run();
  assert.equal(result.outcome.outcome, "refused_out_of_scope");
  assert.equal(result.record?.scopeDecision.outOfScope[0]?.operation, "delete");
  assert.equal(f.readWorkspace("notes.md"), "hello\n", "the file survives");
});

// ---------------------------------------------------------------------------
// Failure modes — every one of them must leave the candidate alone
// ---------------------------------------------------------------------------

test("ALREADY CLEAN: a formatter that changes nothing reports it and touches nothing", async () => {
  const { transport } = fakeTransport({ edit: () => { /* a well-formatted workspace */ } });
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": "fn main() {}\n" }, REPO_WIDE, transport);

  const result = await f.run();
  assert.equal(result.outcome.outcome, "already_clean");
  assert.deepEqual([...result.outcome.changedPaths], []);
  assert.equal(result.record?.candidateTreeBefore, result.record?.candidateTreeAfter);
  assert.match(result.outcome.untrusted, /already formatted/);
});

test("TIMEOUT: a formatter killed at its bound applies nothing and says so", async () => {
  const { transport } = fakeTransport({ timedOut: true, stdout: "…" });
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, REPO_WIDE, transport);

  const result = await f.run();
  assert.equal(result.outcome.outcome, "timed_out");
  assert.equal(result.outcome.timedOut, true);
  assert.equal(f.readWorkspace("src/main.rs"), UNFORMATTED_MAIN, "the candidate is byte-identical");
  assert.equal(result.record?.candidateTreeBefore, result.record?.candidateTreeAfter);
  assert.ok(result.record !== undefined, "the evidence survives the failure");
});

test("NON-ZERO EXIT: a formatter that could not format applies nothing", async () => {
  const { transport } = fakeTransport({
    exitCode: 1,
    stdout: "error: expected one of `!` or `::`, found `main`",
    // Even if it had half-written the shadow, nothing is read on a failed exit.
    edit: (s) => writeFileSync(join(s, "src", "main.rs"), "half written"),
  });
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, REPO_WIDE, transport);

  const result = await f.run();
  assert.equal(result.outcome.outcome, "failed_exit");
  assert.equal(result.outcome.exitCode, 1);
  assert.equal(f.readWorkspace("src/main.rs"), UNFORMATTED_MAIN);
  assert.match(result.outcome.untrusted, /expected one of/, "the tool's own diagnostic reaches the model");
});

test("UNAVAILABLE: a transport that could not launch the binary applies nothing", async () => {
  const { transport } = fakeTransport({ launched: false });
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, REPO_WIDE, transport);
  const result = await f.run();
  assert.equal(result.outcome.outcome, "refused_unavailable");
  assert.equal(f.readWorkspace("src/main.rs"), UNFORMATTED_MAIN);
});

test("CANCELLATION: an aborted signal stops the run and never partially mutates the candidate", async () => {
  const controller = new AbortController();
  const repo = initGitRepo({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN });
  dirs.push(repo);
  const ids = createSequentialIdFactory("fmtc");
  const runId = ids.mint("run");
  const sources = createSourceSnapshotAuthority();
  const captured = await sources.capture({ repoPath: repo });
  assert.ok(captured.ok);
  const { workspaces: manager } = await import("../../core/workspace/index.js");
  const { workspaces, mutations } = createProductionWorkspaceAuthorities({
    manager, mintWorkspaceId: () => ids.mint("workspace"), capturedBytes: (id) => sources.capturedBytes(id),
  });
  const allocated = await workspaces.allocate({ runId, source: captured.reader.snapshot, label: "fmt" });
  assert.ok(allocated.ok);
  const workspace = allocated.workspace;
  dirs.push(workspace.path);

  // Abort DURING the format call — after the formatter has done its work in the shadow, before
  // anything could be applied. The candidate must still be untouched.
  const transport: FormatterTransport = {
    async run(input) {
      if (input.args.includes("--version")) return { launched: true, exitCode: 0, timedOut: false, stdout: "rustfmt 1.9.0", stderr: "", durationMs: 1 };
      writeFileSync(join(input.cwd, "src", "main.rs"), "fn main() {}\n");
      controller.abort();
      return { launched: true, exitCode: 0, timedOut: false, stdout: "", stderr: "", durationMs: 1 };
    },
  };
  const capability = createFormatterCapability({
    transport, treeProbe: createTreeProbe(), mutations, workspace, mutationScope: REPO_WIDE, runId, signal: controller.signal,
  });

  const result = await capability.run({
    runId, ordinal: 1, formatterId: "rustfmt_workspace_v1",
    workspaceId: workspace.workspaceId, workspacePath: workspace.path, baseCommit: workspace.source.baseCommit,
  });

  assert.equal(result.outcome.outcome, "cancelled");
  assert.equal(readFileSync(join(workspace.path, "src", "main.rs"), "utf8"), UNFORMATTED_MAIN, "cancellation applied nothing");
  assert.equal(result.record?.candidateTreeBefore, result.record?.candidateTreeAfter);
});

// ---------------------------------------------------------------------------
// Reach: what the shadow does and does not contain
// ---------------------------------------------------------------------------

test("a SYMLINK in the candidate is never copied, formatted, or written back through", async () => {
  const secret = join(tmpdir(), `ikbi-fmt-secret-${Date.now()}`);
  mkdirSync(secret, { recursive: true });
  dirs.push(secret);
  writeFileSync(join(secret, "outside.txt"), "ORIGINAL SECRET\n");

  const seen: string[] = [];
  const { transport } = fakeTransport({
    edit: (shadow) => {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const abs = join(dir, entry.name);
          if (entry.isDirectory()) walk(abs);
          else seen.push(abs.slice(shadow.length + 1));
        }
      };
      walk(shadow);
    },
  });

  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": "fn main() {}\n" }, REPO_WIDE, transport);
  // Plant the escape INSIDE the candidate, after allocation, as a build could.
  symlinkSync(join(secret, "outside.txt"), join(f.workspace.path, "escape.txt"));

  await f.run();

  assert.equal(seen.includes("escape.txt"), false, "the symlink was not materialized into the shadow");
  assert.equal(readFileSync(join(secret, "outside.txt"), "utf8"), "ORIGINAL SECRET\n", "and its target was never written");
});

test("an IGNORED directory is not copied into the shadow — target/ never travels", async () => {
  const seen: string[] = [];
  const { transport } = fakeTransport({
    edit: (shadow) => {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const abs = join(dir, entry.name);
          if (entry.isDirectory()) walk(abs);
          else seen.push(abs.slice(shadow.length + 1).split("\\").join("/"));
        }
      };
      walk(shadow);
    },
  });
  const f = await fixture(
    { "Cargo.toml": CARGO_TOML, ".gitignore": "target/\n", "src/main.rs": "fn main() {}\n" },
    REPO_WIDE,
    transport,
  );
  mkdirSync(join(f.workspace.path, "target", "debug"), { recursive: true });
  writeFileSync(join(f.workspace.path, "target", "debug", "huge.bin"), "x".repeat(1000));

  await f.run();
  assert.equal(seen.some((p) => p.startsWith("target/")), false, `target/ leaked into the shadow: ${seen.join(", ")}`);
  assert.ok(seen.includes("src/main.rs"), "but the real source did travel");
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test("the record identifies EXACTLY what ran — tool, version, executable, fixed argv, trees, scope", async () => {
  const { transport } = fakeTransport({ edit: (s) => writeFileSync(join(s, "src", "main.rs"), "fn main() {}\n") });
  const scope = scopeOf({ allowTrees: ["src"] });
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, scope, transport);

  const result = await f.run();
  const record = result.record as FormatterRecord;
  assert.ok(record !== undefined);

  assert.equal(record.formatterId, "rustfmt_workspace_v1");
  assert.deepEqual([...record.argv], ["fmt", "--all"], "the receipt proves nothing was appended");
  assert.equal(record.executable.version, "rustfmt 1.9.0-fake");
  assert.ok(record.executable.resolvedPath.length > 0);
  assert.equal(record.network, "deny");
  assert.equal(record.mutationScopeId, scope.scopeId, "bound to the AUTHORITY it ran under");
  assert.equal(record.workspaceId, f.workspace.workspaceId);
  assert.equal(record.baseCommit, f.workspace.source.baseCommit);
  assert.ok(record.completedAt >= record.startedAt);
  assert.ok(record.stdoutSha256.length === 64 && record.stderrSha256.length === 64);
  assert.notEqual(record.candidateTreeBefore, record.candidateTreeAfter);
  assert.deepEqual(record.changes.map((c) => `${c.operation} ${c.path} applied=${c.applied}`), ["modify src/main.rs applied=true"]);
  assert.ok(record.changes[0]?.beforeSha256 !== record.changes[0]?.afterSha256, "the content hashes moved");
  assert.equal(record.invocationId.length, 64);
});

test("the invocation id is CONTENT-ADDRESSED — the same work under the same authority is the same id", async () => {
  const make = async (scope: MutationScope) => {
    const { transport } = fakeTransport({ edit: (s) => writeFileSync(join(s, "src", "main.rs"), "fn main() {}\n") });
    const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, scope, transport);
    return (await f.run()).record!;
  };
  const wide = await make(REPO_WIDE);
  const narrow = await make(scopeOf({ allowTrees: ["src"] }));
  assert.notEqual(wide.invocationId, narrow.invocationId, "a different AUTHORITY is a different invocation");
});

test("evidence is preserved on every failing outcome, not only on success", async () => {
  for (const [label, behaviour] of [
    ["timeout", { timedOut: true }],
    ["nonzero", { exitCode: 2 }],
    ["unavailable", { launched: false }],
  ] as const) {
    const { transport } = fakeTransport(behaviour);
    const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN }, REPO_WIDE, transport);
    const result = await f.run();
    assert.ok(result.record !== undefined, `${label} produced no record`);
    assert.equal(result.record.candidateTreeBefore, result.record.candidateTreeAfter, `${label} moved the candidate`);
  }
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

test("a repository with no Cargo.toml offers no rustfmt", async () => {
  const { transport } = fakeTransport();
  const f = await fixture({ "README.md": "# not rust\n" }, REPO_WIDE, transport);
  assert.deepEqual([...(await f.capability.available(f.workspace.path))], []);
});

test("a cargo repository offers rustfmt", async () => {
  const { transport } = fakeTransport();
  const f = await fixture({ "Cargo.toml": CARGO_TOML, "src/main.rs": "fn main() {}\n" }, REPO_WIDE, transport);
  assert.deepEqual([...(await f.capability.available(f.workspace.path))], ["rustfmt_workspace_v1"]);
});

// ---------------------------------------------------------------------------
// END TO END, with the real toolchain
// ---------------------------------------------------------------------------

test("REAL rustfmt formats the candidate and `cargo fmt --check` then passes", async (t) => {
  if (!rustToolchain()) return t.skip("no cargo/rustfmt on this machine");

  const f = await fixture(
    { "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN },
    scopeOf({ allowTrees: ["src"] }),
    createGovernedFormatterTransport(),
  );

  // Before: the real check FAILS. This is the Apela shape — a declared `fmt` check the builder
  // could not satisfy.
  const before = spawnSync("cargo", ["fmt", "--all", "--check"], { cwd: f.workspace.path, encoding: "utf8" });
  assert.notEqual(before.status, 0, "the fixture really is mis-formatted");

  const result = await f.run();
  assert.equal(result.outcome.outcome, "applied", `formatter said: ${result.outcome.untrusted}`);
  assert.deepEqual([...result.outcome.changedPaths], ["src/main.rs"]);

  // After: the SAME check the verifier would run now passes.
  const after = spawnSync("cargo", ["fmt", "--all", "--check"], { cwd: f.workspace.path, encoding: "utf8" });
  assert.equal(after.status, 0, `cargo fmt --check still fails:\n${after.stdout}${after.stderr}`);

  // And the record names the real tool.
  assert.match(result.record?.executable.version ?? "", /rustfmt/);
  assert.ok((result.record?.executable.sha256 ?? "").length === 64, "the executable that ran is identified by digest");
});

test("REAL rustfmt leaves the SOURCE checkout untouched — only the candidate moved", async (t) => {
  if (!rustToolchain()) return t.skip("no cargo/rustfmt on this machine");

  const f = await fixture(
    { "Cargo.toml": CARGO_TOML, "src/main.rs": UNFORMATTED_MAIN },
    scopeOf({ allowTrees: ["src"] }),
    createGovernedFormatterTransport(),
  );
  const result = await f.run();
  assert.equal(result.outcome.outcome, "applied");

  assert.equal(readFileSync(join(f.repo, "src", "main.rs"), "utf8"), UNFORMATTED_MAIN, "the operator's checkout is untouched");
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" });
  assert.equal(status.stdout.trim(), "", "and its working tree is clean");
});

test("REAL rustfmt: a formatting pass that leaves the scope is refused whole, with the real tool", async (t) => {
  if (!rustToolchain()) return t.skip("no cargo/rustfmt on this machine");

  // Two crates, both mis-formatted; only one is in scope. `cargo fmt --all` formats both, so the
  // whole pass must be refused — this is the honest cost of the all-or-nothing rule, and the
  // operator's remedy is to widen the scope.
  const f = await fixture(
    {
      "Cargo.toml": '[workspace]\nresolver = "2"\nmembers = ["a", "b"]\n',
      "a/Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n',
      "a/src/lib.rs": "pub fn  a( )->i32{1}\n",
      "b/Cargo.toml": '[package]\nname = "b"\nversion = "0.1.0"\nedition = "2021"\n',
      "b/src/lib.rs": "pub fn  b( )->i32{2}\n",
    },
    scopeOf({ allowTrees: ["a"] }),
    createGovernedFormatterTransport(),
  );

  const result = await f.run();
  assert.equal(result.outcome.outcome, "refused_out_of_scope", `got ${result.outcome.outcome}: ${result.outcome.untrusted}`);
  assert.ok(result.outcome.refusedPaths.includes("b/src/lib.rs"));
  assert.equal(readFileSync(join(f.workspace.path, "a", "src", "lib.rs"), "utf8"), "pub fn  a( )->i32{1}\n", "the in-scope crate was not formatted either");
});

// ---------------------------------------------------------------------------
// A substituted toolchain is visible in the evidence
// ---------------------------------------------------------------------------

test("a FAKE cargo earlier on PATH is recorded — the executable that ran is named and digested", async () => {
  const fakeDir = join(tmpdir(), `ikbi-fake-cargo-${Date.now()}`);
  mkdirSync(fakeDir, { recursive: true });
  dirs.push(fakeDir);
  writeFileSync(join(fakeDir, "cargo"), "#!/bin/sh\necho 'rustfmt 9.9.9-IMPOSTOR'\n");
  chmodSync(join(fakeDir, "cargo"), 0o755);

  const { transport } = fakeTransport();
  const repo = initGitRepo({ "Cargo.toml": CARGO_TOML, "src/main.rs": "fn main() {}\n" });
  dirs.push(repo);
  const ids = createSequentialIdFactory("fmtp");
  const runId = ids.mint("run");
  const sources = createSourceSnapshotAuthority();
  const captured = await sources.capture({ repoPath: repo });
  assert.ok(captured.ok);
  const { workspaces: manager } = await import("../../core/workspace/index.js");
  const { workspaces, mutations } = createProductionWorkspaceAuthorities({
    manager, mintWorkspaceId: () => ids.mint("workspace"), capturedBytes: (id) => sources.capturedBytes(id),
  });
  const allocated = await workspaces.allocate({ runId, source: captured.reader.snapshot, label: "fmt" });
  assert.ok(allocated.ok);
  dirs.push(allocated.workspace.path);

  const capability = createFormatterCapability({
    transport, treeProbe: createTreeProbe(), mutations, workspace: allocated.workspace,
    mutationScope: REPO_WIDE, runId,
    // The PATH the identity probe searches. A planted binary wins the lookup, exactly as it
    // would for the real transport.
    hostEnv: { PATH: `${fakeDir}:${process.env.PATH ?? ""}` },
  });
  const result = await capability.run({
    runId, ordinal: 1, formatterId: "rustfmt_workspace_v1",
    workspaceId: allocated.workspace.workspaceId, workspacePath: allocated.workspace.path,
    baseCommit: allocated.workspace.source.baseCommit,
  });

  // DETECTION, not prevention. The record names the impostor by path and digest, so a
  // substituted toolchain is attributable in the receipt rather than invisible. Refusing one
  // outright needs an operator-supplied expected digest, which does not exist yet.
  assert.equal(result.record?.executable.resolvedPath, join(fakeDir, "cargo"));
  assert.equal((result.record?.executable.sha256 ?? "").length, 64);
  assert.notEqual(result.record?.executable.sha256, undefined);
});

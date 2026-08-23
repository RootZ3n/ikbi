/**
 * THE FORMATTER CAPABILITY — a governed formatter that never writes to the candidate.
 *
 * The shape, and why every step is where it is:
 *
 *   1. ENUMERATE the candidate's git-visible files and hash them. `git ls-files` plus untracked-
 *      but-not-ignored, so `target/`, `node_modules/` and every other ignored tree stay out. That
 *      is both a correctness point (the shadow matches what the tree id is computed over) and a
 *      practical one — copying a Rust `target/` would be gigabytes.
 *   2. MATERIALIZE a SHADOW copy of exactly those files in a private temp directory.
 *   3. RUN the formatter there, through governed-exec, with a fixed argv, a sanitized environment,
 *      the network denied and a wall-clock bound.
 *   4. DIFF the shadow against the hashes from step 1.
 *   5. DECIDE the whole change set against the operator's mutation scope. All or nothing.
 *   6. APPLY the accepted bytes to the CANDIDATE through the state-bound mutation authority —
 *      observe, compare-and-swap, atomic write — exactly as any other edit.
 *
 * WHY THE SHADOW, restated because it is the design. `cargo fmt` rewrites in place. Pointing it at
 * the candidate would give a subprocess direct write authority over the tree, and the whole point
 * of the state-bound core is that NOTHING has that. With the shadow, the candidate is not touched
 * until after the formatter has finished and been adjudicated — so a timeout, a cancellation, a
 * crash or a non-zero exit leaves it byte-identical, and there is no partial state to unwind.
 *
 * WHAT THE MODEL CONTRIBUTES: an identifier. Nothing on the command line, in the environment, or
 * in the paths comes from it, and there is no parameter through which it could.
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import pino from "pino";

import { createGovernedExec } from "../../modules/governed-exec/index.js";
import type { GovernedExec } from "../../modules/governed-exec/index.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { IdentityResolver, beginOperation } from "../../core/identity/resolver.js";
import type { OperationContext } from "../../core/identity/index.js";
import { runGit } from "../../core/workspace/git.js";
import {
  boundStream,
  formatterDefinition,
  formatterInvocationDigest,
  formatterPartialApplicationFailure,
  formatterToolOutcome,
  isFormatterId,
  type FormatterCapability,
  type FormatterChange,
  type FormatterDefinition,
  type FormatterExecutableIdentity,
  type FormatterId,
  type FormatterOutcomeKind,
  type FormatterRecord,
  type FormatterRequest,
  type FormatterResult,
  type FormatterScopeDecision,
} from "../core/formatter.js";
import { decideMutation, type MutationOperationKind, type MutationScope } from "../core/mutation-scope.js";
import type { StateBoundMutationAuthority, V2WorkspaceRecord } from "../core/workspace.js";
import type { TreeProbe } from "../core/verification.js";
import type { V2RunId } from "../core/identity.js";

/** governed-exec stamps this exit code when its streaming path kills a timed-out command. */
const TIMEOUT_EXIT_CODE = 124;

/** A formatter must never see a file this large; a repository with one is not a formatting target. */
const MAX_SHADOW_FILE_BYTES = 8 * 1024 * 1024;
/** Nor a tree this wide. A bound, so a pathological repository cannot stall a build in `cp`. */
const MAX_SHADOW_FILES = 20_000;

const sha256Buf = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------------------
// Execution seam
// ---------------------------------------------------------------------------

/** The narrow governed-execution seam. Production wires governed-exec; tests inject a fake. */
export interface FormatterTransport {
  run(input: {
    readonly program: string;
    readonly args: readonly string[];
    /** Absolute path of the SHADOW root. Never the candidate. */
    readonly cwd: string;
    readonly timeoutMs: number;
    /** The single writable host root: the shadow. The candidate is not in this list. */
    readonly writableRoot: string;
  }): Promise<FormatterTransportResult>;
}

export interface FormatterTransportResult {
  readonly launched: boolean;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly refusedReason?: string;
}

/** Mint a self-contained trusted identity for formatter execution. Grants no verifier authority. */
function mintFormatterContext(): OperationContext {
  const token = randomBytes(32).toString("hex");
  const registry = new AgentRegistry({
    agents: [{ agentId: "ikbi-v2-formatter", kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken(token)] }],
  });
  const resolver = new IdentityResolver({ registry, logger: pino({ enabled: false }) });
  return beginOperation(resolver.resolve({ token }), { requestId: `v2-fmt-${randomBytes(4).toString("hex")}` });
}

/**
 * The production transport.
 *
 * `verifier: false` — a formatter is not a verifier and must not be able to run package scripts.
 * The sandbox's only writable root is the shadow, so even a compromised or misbehaving toolchain
 * cannot reach the candidate through the filesystem.
 */
export function createGovernedFormatterTransport(deps: { readonly governedExec?: Pick<GovernedExec, "run">; readonly now?: () => number } = {}): FormatterTransport {
  const now = deps.now ?? Date.now;
  const parentCtx = mintFormatterContext();
  let exec: Pick<GovernedExec, "run"> | undefined = deps.governedExec;
  const executor = (): Pick<GovernedExec, "run"> => (exec ??= createGovernedExec());

  return {
    async run(input): Promise<FormatterTransportResult> {
      const startedAt = now();
      let combined = "";
      const res = await executor().run({
        parentCtx,
        command: input.program,
        args: [...input.args],
        cwd: input.cwd,
        // THE SHADOW IS THE ONLY WRITABLE ROOT. The candidate is not in the sandbox's writable
        // set at all, so the formatter cannot reach it through the filesystem even in principle.
        worktreeRoot: input.writableRoot,
        verifier: false,
        purpose: `v2 governed formatter (${input.program})`,
        timeoutMs: input.timeoutMs,
        onOutput: (chunk) => { combined += chunk; },
      });
      const durationMs = now() - startedAt;
      if (!res.executed) {
        return { launched: false, timedOut: false, stdout: "", stderr: combined, durationMs, refusedReason: res.reason ?? "not executed" };
      }
      const exitCode = res.exitCode ?? 1;
      // governed-exec merges the streams; the record keeps them as one bounded body rather than
      // pretending to a separation the transport does not provide.
      return { launched: true, exitCode, timedOut: exitCode === TIMEOUT_EXIT_CODE, stdout: combined, stderr: "", durationMs };
    },
  };
}

// ---------------------------------------------------------------------------
// Shadow materialization
// ---------------------------------------------------------------------------

/** One file in the candidate, as the shadow needs to know it. */
interface TrackedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * The set of files a formatter may see: everything git considers part of the tree.
 *
 * `ls-files -z` for tracked and `--others --exclude-standard -z` for new-but-not-ignored, which is
 * exactly the population `git add -A` (and therefore the candidate tree id) covers. NUL-delimited
 * so a path with a newline in it cannot split one entry into two.
 */
async function trackedFiles(root: string): Promise<{ readonly ok: true; readonly files: readonly TrackedFile[] } | { readonly ok: false; readonly reason: string }> {
  const collect = async (args: readonly string[]): Promise<string[]> => {
    const res = await runGit(root, [...args]);
    if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim().slice(0, 200)}`);
    return res.stdout.split("\0").filter((p) => p.length > 0);
  };

  let names: string[];
  try {
    names = [...new Set([...(await collect(["ls-files", "-z"])), ...(await collect(["ls-files", "--others", "--exclude-standard", "-z"]))])].sort();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (names.length > MAX_SHADOW_FILES) {
    return { ok: false, reason: `the candidate has ${names.length} files, above the ${MAX_SHADOW_FILES}-file formatter ceiling` };
  }

  const files: TrackedFile[] = [];
  for (const name of names) {
    const abs = join(root, name);
    let st: import("node:fs").Stats;
    try {
      // lstat, not stat: a SYMLINK is never copied into the shadow and never formatted. Following
      // one would let a link inside the candidate pull an arbitrary host file into the formatter's
      // view — and, worse, let a formatted result be written back through it.
      st = lstatSync(abs);
    } catch {
      continue; // raced away between the listing and here; it is simply not in the shadow
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    if (st.size > MAX_SHADOW_FILE_BYTES) continue;
    try {
      files.push({ path: name, sha256: sha256Buf(readFileSync(abs)), bytes: st.size });
    } catch {
      continue;
    }
  }
  return { ok: true, files };
}

/** Copy the tracked set into a fresh private directory. Returns the shadow root. */
function materializeShadow(root: string, files: readonly TrackedFile[]): string {
  const shadow = mkdtempSync(join(tmpdir(), "ikbi-v2-fmt-"));
  chmodSync(shadow, 0o700);
  for (const file of files) {
    const target = join(shadow, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(join(root, file.path), target);
  }
  return shadow;
}

/** Re-hash the shadow after the formatter ran, over the SAME path set plus anything new. */
function shadowState(shadow: string): Map<string, { sha256: string; buffer: Buffer }> {
  const out = new Map<string, { sha256: string; buffer: Buffer }>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.isFile()) continue;
      try {
        const st = statSync(abs);
        if (st.size > MAX_SHADOW_FILE_BYTES) continue;
        const buffer = readFileSync(abs);
        out.set(relative(shadow, abs).split(sep).join("/"), { sha256: sha256Buf(buffer), buffer });
      } catch {
        continue;
      }
    }
  };
  walk(shadow);
  return out;
}

// ---------------------------------------------------------------------------
// Executable identity
// ---------------------------------------------------------------------------

/**
 * What actually ran.
 *
 * Recorded rather than pinned. A digest here makes a substituted binary VISIBLE and attributable
 * in the receipt — a fake `cargo` earlier on PATH produces a different resolved path and a
 * different hash, and the evidence says so. REFUSING one would need an operator-supplied expected
 * digest, which does not exist yet; that is a real limitation and is reported as one rather than
 * papered over with a check that cannot actually decide anything.
 */
function executableIdentity(program: string, searchPath: string, version: string): FormatterExecutableIdentity {
  const search = searchPath.split(":").filter((p) => p.length > 0);
  for (const dir of search) {
    const candidate = join(dir, program);
    try {
      if (!existsSync(candidate)) continue;
      const resolved = realpathSync(candidate);
      const buf = readFileSync(resolved);
      return { resolvedPath: resolved, sha256: sha256Buf(buf), byteLength: buf.length, version };
    } catch {
      continue;
    }
  }
  return { resolvedPath: program, version };
}

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

export interface FormatterCapabilityDeps {
  readonly transport: FormatterTransport;
  readonly treeProbe: TreeProbe;
  readonly mutations: StateBoundMutationAuthority;
  readonly workspace: V2WorkspaceRecord;
  readonly mutationScope: MutationScope;
  readonly runId: V2RunId;
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /** Aborts an in-flight invocation. A fired signal means NOTHING is applied. */
  readonly signal?: AbortSignal;
}

/** Which formatters this repository actually supports — a marker file must be present. */
function applicableFormatters(workspacePath: string): readonly FormatterId[] {
  const out: FormatterId[] = [];
  for (const id of ["rustfmt_workspace_v1"] as const) {
    const def = formatterDefinition(id);
    if (def.requires.every((marker) => existsSync(join(workspacePath, marker)))) out.push(id);
  }
  return out;
}

export function createFormatterCapability(deps: FormatterCapabilityDeps): FormatterCapability {
  const now = deps.now ?? Date.now;
  const hostEnv = deps.hostEnv ?? process.env;

  return {
    async available(workspacePath: string): Promise<readonly FormatterId[]> {
      return applicableFormatters(workspacePath);
    },

    async run(request: FormatterRequest): Promise<FormatterResult> {
      const startedAt = now();
      const def = formatterDefinition(request.formatterId);

      // The candidate tree BEFORE anything. Every non-`applied` outcome must end equal to it.
      const treeBefore = await deps.treeProbe.treeOf(request.workspacePath);

      const finish = (input: {
        outcome: FormatterOutcomeKind;
        executable: FormatterExecutableIdentity;
        exitCode?: number | undefined;
        timedOut?: boolean | undefined;
        cancelled?: boolean | undefined;
        stdout: string;
        stderr: string;
        treeAfter: string;
        changes: readonly FormatterChange[];
        scopeDecision: FormatterScopeDecision;
      }): FormatterResult => {
        const out = boundStream(input.stdout, def.maxOutputBytes);
        const err = boundStream(input.stderr, def.maxOutputBytes);
        const record: FormatterRecord = Object.freeze({
          invocationId: formatterInvocationDigest({
            runId: request.runId,
            ordinal: request.ordinal,
            formatterId: def.formatterId,
            formatterVersion: input.executable.version,
            workspaceId: request.workspaceId,
            baseCommit: request.baseCommit,
            mutationScopeId: deps.mutationScope.scopeId,
            treeBefore,
          }),
          runId: request.runId,
          ordinal: request.ordinal,
          formatterId: def.formatterId,
          executable: input.executable,
          argv: [...def.argv],
          workspaceId: request.workspaceId,
          baseCommit: request.baseCommit,
          mutationScopeId: deps.mutationScope.scopeId,
          network: def.network,
          timeoutMs: def.timeoutMs,
          startedAt,
          completedAt: now(),
          outcome: input.outcome,
          ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
          timedOut: input.timedOut === true,
          cancelled: input.cancelled === true,
          stdoutSha256: out.sha256,
          stdoutExcerpt: out.excerpt,
          stderrSha256: err.sha256,
          stderrExcerpt: err.excerpt,
          outputTruncated: out.truncated || err.truncated,
          candidateTreeBefore: treeBefore,
          candidateTreeAfter: input.treeAfter,
          changes: Object.freeze([...input.changes]),
          scopeDecision: input.scopeDecision,
        });
        return { outcome: formatterToolOutcome(record), record };
      };

      /**
       * Attach the hard safety failure — but ONLY when writes had already landed.
       *
       * A failure on the FIRST file changed nothing, so it is an ordinary unsuccessful
       * invocation and the build continues. A failure after some files landed leaves the
       * candidate partly formatted, which is a state no formatter produced and nothing
       * verified, so the build stops rather than proceeding to check it.
       */
      const withPartialFailure = (
        result: FormatterResult,
        appliedCount: number,
        totalCount: number,
        path: string,
        reason: string,
      ): FormatterResult =>
        appliedCount === 0
          ? result
          : { ...result, safetyFailure: formatterPartialApplicationFailure({ formatterId: def.formatterId, appliedCount, totalCount, path, reason }) };

      /** Read the signal FRESHLY each time; a direct property test gets narrowed away by TS. */
      const cancelled = (): boolean => Boolean(deps.signal?.aborted);

      const noChanges: FormatterScopeDecision = { permitted: true, inScope: [], outOfScope: [] };
      const unknownExecutable: FormatterExecutableIdentity = { resolvedPath: def.program, version: "(not observed)" };

      // Cancellation BEFORE anything: nothing ran, nothing changed.
      if (cancelled()) {
        return finish({ outcome: "cancelled", executable: unknownExecutable, cancelled: true, stdout: "", stderr: "", treeAfter: treeBefore, changes: [], scopeDecision: noChanges });
      }

      // 1. ENUMERATE.
      const listed = await trackedFiles(request.workspacePath);
      if (!listed.ok) {
        return finish({ outcome: "infrastructure_failure", executable: unknownExecutable, stdout: "", stderr: listed.reason, treeAfter: treeBefore, changes: [], scopeDecision: noChanges });
      }
      const before = new Map(listed.files.map((f) => [f.path, f.sha256]));

      // 2. MATERIALIZE.
      let shadow: string;
      try {
        shadow = materializeShadow(request.workspacePath, listed.files);
      } catch (err) {
        return finish({ outcome: "infrastructure_failure", executable: unknownExecutable, stdout: "", stderr: err instanceof Error ? err.message : String(err), treeAfter: treeBefore, changes: [], scopeDecision: noChanges });
      }

      try {
        // 3a. VERSION — a fixed argv, observed before the work so the record can name the tool.
        const probe = await deps.transport.run({ program: def.program, args: def.versionArgv, cwd: shadow, timeoutMs: 30_000, writableRoot: shadow });
        const version = probe.launched && probe.exitCode === 0 ? probe.stdout.trim().split("\n")[0]?.trim() ?? "(empty)" : "(unavailable)";
        const executable = executableIdentity(def.program, hostEnv.PATH ?? "", version);
        if (!probe.launched) {
          return finish({ outcome: "refused_unavailable", executable, stdout: probe.stdout, stderr: probe.refusedReason ?? probe.stderr, treeAfter: treeBefore, changes: [], scopeDecision: noChanges });
        }

        if (cancelled()) {
          return finish({ outcome: "cancelled", executable, cancelled: true, stdout: "", stderr: "", treeAfter: treeBefore, changes: [], scopeDecision: noChanges });
        }

        // 3b. FORMAT — fixed argv, sanitized env, shadow cwd, bounded, network denied.
        const run = await deps.transport.run({ program: def.program, args: def.argv, cwd: shadow, timeoutMs: def.timeoutMs, writableRoot: shadow });

        if (run.timedOut) {
          // THE CANDIDATE WAS NEVER TOUCHED. There is nothing to unwind, which is the entire
          // reason the formatter runs somewhere else.
          return finish({ outcome: "timed_out", executable, exitCode: run.exitCode, timedOut: true, stdout: run.stdout, stderr: run.stderr, treeAfter: treeBefore, changes: [], scopeDecision: noChanges });
        }
        if (!run.launched) {
          return finish({ outcome: "refused_unavailable", executable, stdout: run.stdout, stderr: run.refusedReason ?? run.stderr, treeAfter: treeBefore, changes: [], scopeDecision: noChanges });
        }
        if (!def.permittedExitCodes.includes(run.exitCode ?? -1)) {
          return finish({ outcome: "failed_exit", executable, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, treeAfter: treeBefore, changes: [], scopeDecision: noChanges });
        }
        if (cancelled()) {
          return finish({ outcome: "cancelled", executable, cancelled: true, stdout: run.stdout, stderr: run.stderr, treeAfter: treeBefore, changes: [], scopeDecision: noChanges });
        }

        // 4. DIFF the shadow.
        const after = shadowState(shadow);
        const proposed: { path: string; operation: MutationOperationKind; beforeSha256: string | null; afterSha256: string | null; buffer?: Buffer }[] = [];
        for (const [path, state] of [...after.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          const was = before.get(path);
          if (was === undefined) {
            proposed.push({ path, operation: "create", beforeSha256: null, afterSha256: state.sha256, buffer: state.buffer });
          } else if (was !== state.sha256) {
            proposed.push({ path, operation: "modify", beforeSha256: was, afterSha256: state.sha256, buffer: state.buffer });
          }
        }
        for (const [path, was] of [...before.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          if (!after.has(path)) proposed.push({ path, operation: "delete", beforeSha256: was, afterSha256: null });
        }

        if (proposed.length === 0) {
          return finish({ outcome: "already_clean", executable, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, treeAfter: treeBefore, changes: [], scopeDecision: noChanges });
        }

        // 5. DECIDE — the WHOLE set, against the operator's scope.
        const outOfScope: { path: string; operation: MutationOperationKind; detail: string }[] = [];
        const inScope: string[] = [];
        for (const change of proposed) {
          const decision = decideMutation(deps.mutationScope, { path: change.path, operation: change.operation });
          if (decision.allowed) inScope.push(change.path);
          else outOfScope.push({ path: change.path, operation: change.operation, detail: decision.detail });
        }
        if (outOfScope.length > 0) {
          // ALL OR NOTHING. Applying the in-scope subset would leave the candidate in a state the
          // formatter never produced — half-formatted, and verified as if it were the real thing.
          return finish({
            outcome: "refused_out_of_scope", executable, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr,
            treeAfter: treeBefore,
            changes: proposed.map((c) => ({ path: c.path, operation: c.operation, beforeSha256: c.beforeSha256, afterSha256: c.afterSha256, applied: false })),
            scopeDecision: { permitted: false, inScope, outOfScope },
          });
        }

        if (cancelled()) {
          return finish({ outcome: "cancelled", executable, cancelled: true, stdout: run.stdout, stderr: run.stderr, treeAfter: treeBefore, changes: [], scopeDecision: { permitted: true, inScope, outOfScope: [] } });
        }

        // 6. APPLY through the state-bound authority. Every write observes, compare-and-swaps and
        //    writes atomically — the formatter gets no shortcut the model does not have.
        const applied: FormatterChange[] = [];
        for (const change of proposed) {
          const read = await deps.mutations.read({ runId: deps.runId, workspace: deps.workspace, path: change.path, maxChars: 0 });
          if (!read.ok) {
            return withPartialFailure(
              finish({
                outcome: "infrastructure_failure", executable, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr,
                treeAfter: await deps.treeProbe.treeOf(request.workspacePath),
                changes: applied, scopeDecision: { permitted: true, inScope, outOfScope: [] },
              }),
              applied.length,
              proposed.length,
              change.path,
              read.failure.message,
            );
          }
          const result = await deps.mutations.mutate({
            runId: deps.runId,
            workspace: deps.workspace,
            observation: read.observation,
            operation: change.operation === "delete" ? { kind: "delete" } : { kind: change.operation === "create" ? "create" : "replace", content: change.buffer ?? Buffer.alloc(0) },
          });
          if (!result.ok) {
            return withPartialFailure(
              finish({
                outcome: "infrastructure_failure", executable, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr,
                treeAfter: await deps.treeProbe.treeOf(request.workspacePath),
                changes: applied, scopeDecision: { permitted: true, inScope, outOfScope: [] },
              }),
              applied.length,
              proposed.length,
              change.path,
              result.failure.message,
            );
          }
          applied.push({ path: change.path, operation: change.operation, beforeSha256: change.beforeSha256, afterSha256: change.afterSha256, applied: true });
        }

        return finish({
          outcome: "applied", executable, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr,
          treeAfter: await deps.treeProbe.treeOf(request.workspacePath),
          changes: applied,
          scopeDecision: { permitted: true, inScope, outOfScope: [] },
        });
      } finally {
        // The shadow is scratch and never outlives the invocation, whatever happened.
        try { rmSync(shadow, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    },
  };
}

/** Resolve a model-supplied identifier, or explain why it is not one. Pure. */
export function resolveFormatterId(raw: string): { readonly ok: true; readonly id: FormatterId } | { readonly ok: false; readonly detail: string } {
  const trimmed = raw.trim();
  if (!isFormatterId(trimmed)) {
    return { ok: false, detail: `"${raw}" is not a formatter you have` };
  }
  return { ok: true, id: trimmed };
}

/** The definition type, re-exported so a caller needs one import for the pure half. */
export type { FormatterDefinition };

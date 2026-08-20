/**
 * ikbi v2 — THE BUILDER COMMAND AUTHORITY (V2-015).
 *
 * V2-015 gives the builder a READ-ONLY terminal: it may request a bounded, structured command
 * and receive its output as untrusted evidence. It is emphatically NOT a shell, and it is NOT a
 * second way to change candidate source.
 *
 * THE PRIMARY INVARIANT V2-015 MUST NOT BREACH:
 *
 *   State-bound mutation (observe → CAS → mutate) REMAINS THE ONLY authorized way a model
 *   changes candidate source. A command may INSPECT the workspace; it may never MUTATE it.
 *
 * THREE INDEPENDENT LAYERS enforce that, each sufficient on its own for the class it covers:
 *
 *   1. POLICY (this file). A tiny content-addressed allowlist of provably read-only programs
 *      and argument shapes. `sh`, `python -c`, `sed -i`, `rm`, `git reset`, package managers,
 *      network fetchers — none are expressible, so they are refused BEFORE anything runs.
 *   2. STRUCTURED ARGV. There is no shell. `>`, `|`, `&&`, `;`, `$()`, backticks are ORDINARY
 *      argv characters handed literally to the program — never interpreted. (`parseToolCall`
 *      in tools.ts takes `program` + `args[]`, never a command string.)
 *   3. TREE BEFORE == AFTER. The runtime hashes the candidate tree before and after every
 *      command; ANY change is a hard safety failure that stops the build. OS-independent and
 *      authoritative — it holds even if the policy were widened by mistake.
 *
 * The OS sandbox (governed-exec F1 bwrap) is a fourth, defence-in-depth layer for the risky
 * class: the runtime runs commands with the candidate bound READ-ONLY and only an ephemeral
 * temp writable, network unshared. This file is PURE — policy, evaluation, bounding, record
 * identity. It performs no I/O and holds no capability; see runtime/command-executor.ts.
 */

import { createHash } from "node:crypto";

import { contentDigest, type V2Digest, type V2RunId } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";
import type { ToolOutcome } from "./tools.js";

/** Plain sha256 of UTF-8 text — the same digest the check-runner uses for output hashes. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * How a program's arguments are constrained.
 *
 *   exact_argv   the WHOLE argv must equal one of `exactArgvAllowlist` (version probes).
 *   subcommand   `args[0]` must be one of `readOnlySubcommands` (git's read-only verbs); no
 *                leading program-level flag is permitted (it would not be args[0]).
 *   freeform     any args, minus the `deniedArgTokens` (read-only coreutils/search tools).
 */
export type CommandArgMode = "exact_argv" | "subcommand" | "freeform";

/** One allowed program and the exact shape of arguments it may carry. Declarative — content-addressable. */
export interface CommandRule {
  readonly program: string;
  readonly mode: CommandArgMode;
  /** subcommand mode: the read-only verbs allowed as `args[0]`. */
  readonly readOnlySubcommands?: readonly string[];
  /** exact_argv mode: the complete argv vectors allowed. */
  readonly exactArgvAllowlist?: readonly (readonly string[])[];
  /** Any arg equal to, or prefixed by, one of these tokens is REFUSED (write/escape flags). */
  readonly deniedArgTokens?: readonly string[];
}

/** The workspace access a builder command gets. Only `read_only` exists in this slice. */
export type CommandWorkspaceAccess = "read_only";
/** The network a builder command gets. Only `deny` exists in this slice. */
export type CommandNetworkPolicy = "deny";

/** The immutable, content-addressed policy that governs the builder terminal for a session. */
export interface BuilderCommandPolicy {
  readonly policyId: V2CommandPolicyId;
  readonly rules: readonly CommandRule[];
  readonly workspaceAccess: CommandWorkspaceAccess;
  readonly network: CommandNetworkPolicy;
  /** Max commands one candidate's builder loop may run. */
  readonly maxCommands: number;
  /** Per-command wall-clock bound (ms). The runtime kills the whole process group on breach. */
  readonly timeoutMs: number;
  /** Max bytes of combined output returned to the model (excerpted; the full output is hashed). */
  readonly maxOutputBytes: number;
  /** Max args a single command may carry (a cheap resource guard). */
  readonly maxArgs: number;
}

export type V2CommandPolicyId = V2Digest<"command_policy">;

/**
 * THE shipped builder command policy — deliberately tiny and provably read-only.
 *
 * Every program here is already on governed-exec's default binary allowlist (so the two gates
 * agree), performs no writes, and needs no network:
 *
 *   git  — READ-ONLY verbs only; mutating verbs (add/commit/checkout/switch/reset/clean/restore/
 *          merge/rebase/apply/stash/tag/branch mutations/update-ref/config writes) and network
 *          verbs (fetch/pull/clone/ls-remote/push/remote) are ABSENT, so they are refused. The
 *          verb must be `args[0]` (no `git -C <dir>` / `git -c k=v` escape). `--output` (which
 *          would write a file) is denied.
 *
 *          `cat-file` is ALSO absent (V2-020/Phase 21). Tournament/shadow candidates are worktrees
 *          of ONE repository and therefore share a single git OBJECT STORE. `cat-file` is the
 *          object-enumeration primitive over that store — `--batch-all-objects` lists every object
 *          in it, and `-p <sha>` prints any of them — so an allowed `cat-file` let one candidate
 *          read a SIBLING candidate's blobs and quietly launder them into its own answer. That is a
 *          real cross-candidate information channel, and candidate isolation is an authority
 *          invariant here, not a nicety. Nothing ordinary is lost: a builder inspects its own tree
 *          with `read_file`, `git show`, `git diff`, `git log` and `git grep`, all of which are
 *          scoped to refs and paths it can legitimately name.
 *   grep/find/ls/head/tail/wc — read-only inspection. `find` write/exec actions are denied.
 *   echo — harmless; demonstrates that `>`/`|`/`$()` are literal argv, never shell.
 *
 * NOT here, on purpose: interpreters (node/python), file dumpers (cat — can read secrets),
 * package managers, sed/rm/mv/cp/touch, and anything that networks. Use read_file for content.
 */
export const V2_DEFAULT_COMMAND_POLICY: BuilderCommandPolicy = buildCommandPolicy({
  rules: [
    {
      program: "git",
      mode: "subcommand",
      readOnlySubcommands: [
        "status", "diff", "log", "show", "grep", "rev-parse", "ls-files", "ls-tree",
        "describe", "shortlog", "rev-list", "show-ref", "symbolic-ref",
        "name-rev", "diff-tree", "diff-index", "whatchanged", "blame",
      ],
      deniedArgTokens: ["--output", "-O", "-C", "--git-dir", "--work-tree", "-c", "--exec-path"],
    },
    { program: "grep", mode: "freeform", deniedArgTokens: ["--output"] },
    {
      program: "find",
      mode: "freeform",
      // The find ACTIONS that write / execute — everything else is read-only traversal.
      deniedArgTokens: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"],
    },
    { program: "ls", mode: "freeform" },
    { program: "head", mode: "freeform" },
    { program: "tail", mode: "freeform" },
    { program: "wc", mode: "freeform" },
    { program: "echo", mode: "freeform" },
  ],
  workspaceAccess: "read_only",
  network: "deny",
  maxCommands: 24,
  timeoutMs: 20_000,
  maxOutputBytes: 32_000,
  maxArgs: 64,
});

/** Build a command policy, computing its content id. The id moves when any rule/bound moves. */
export function buildCommandPolicy(input: {
  readonly rules: readonly CommandRule[];
  readonly workspaceAccess: CommandWorkspaceAccess;
  readonly network: CommandNetworkPolicy;
  readonly maxCommands: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxArgs: number;
}): BuilderCommandPolicy {
  const semantic = {
    rules: input.rules.map((r) => ({
      program: r.program,
      mode: r.mode,
      ...(r.readOnlySubcommands !== undefined ? { readOnlySubcommands: [...r.readOnlySubcommands] } : {}),
      ...(r.exactArgvAllowlist !== undefined ? { exactArgvAllowlist: r.exactArgvAllowlist.map((v) => [...v]) } : {}),
      ...(r.deniedArgTokens !== undefined ? { deniedArgTokens: [...r.deniedArgTokens] } : {}),
    })),
    workspaceAccess: input.workspaceAccess,
    network: input.network,
    maxCommands: input.maxCommands,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    maxArgs: input.maxArgs,
  };
  return Object.freeze({ policyId: contentDigest("command_policy", semantic), ...semantic });
}

// ---------------------------------------------------------------------------
// Refusal vocabulary
// ---------------------------------------------------------------------------

/** Why a command request was refused BEFORE anything ran. Closed set — every refusal is explainable. */
export type CommandRefusalCode =
  | "program_not_allowed"
  | "program_has_path"
  | "subcommand_not_allowed"
  | "argv_not_allowed"
  | "denied_argument"
  | "too_many_args"
  | "cwd_escapes_workspace"
  | "malformed_request";

export interface CommandEvaluation {
  readonly ok: boolean;
  readonly program: string;
  readonly args: readonly string[];
  /** Present only when refused. */
  readonly code?: CommandRefusalCode;
  readonly detail?: string;
}

/** The first non-flag token — a program's subcommand (`git status` → `status`). */
function firstSubcommand(args: readonly string[]): string | undefined {
  for (const a of args) {
    if (a.startsWith("-")) return undefined; // a leading flag means the verb is NOT args[0]
    return a;
  }
  return undefined;
}

function argDenied(arg: string, denied: readonly string[]): boolean {
  return denied.some((t) => arg === t || arg.startsWith(`${t}=`) || arg.startsWith(t));
}

/**
 * PURE. Decide whether a structured command is allowed by the policy. It evaluates program,
 * argument shape and denied tokens — it does NOT interpret a shell, resolve a path, or touch a
 * filesystem. cwd confinement is a separate, filesystem-authoritative check in the runtime.
 */
export function evaluateCommand(policy: BuilderCommandPolicy, request: { readonly program: string; readonly args: readonly string[] }): CommandEvaluation {
  const { program, args } = request;
  const base = { program, args };

  if (typeof program !== "string" || program.length === 0) return { ok: false, ...base, code: "malformed_request", detail: "a non-empty program is required" };
  // A bare binary NAME only — never a path. `/bin/sh`, `./x`, `..\\x` are refused here, and the
  // allowlist would refuse them anyway; this makes the intent explicit.
  if (program.includes("/") || program.includes("\\")) return { ok: false, ...base, code: "program_has_path", detail: `program "${program}" must be a bare binary name, not a path` };
  if (args.length > policy.maxArgs) return { ok: false, ...base, code: "too_many_args", detail: `a command may carry at most ${policy.maxArgs} arguments` };

  const rule = policy.rules.find((r) => r.program === program);
  if (rule === undefined) {
    return { ok: false, ...base, code: "program_not_allowed", detail: `"${program}" is not an allowed command; allowed: ${policy.rules.map((r) => r.program).join(", ")}` };
  }

  if (rule.mode === "exact_argv") {
    const allowed = (rule.exactArgvAllowlist ?? []).some((v) => v.length === args.length && v.every((tok, i) => tok === args[i]));
    if (!allowed) return { ok: false, ...base, code: "argv_not_allowed", detail: `"${program}" only accepts a fixed argument vector here` };
    return { ok: true, ...base };
  }

  if (rule.mode === "subcommand") {
    const sub = firstSubcommand(args);
    if (sub === undefined) return { ok: false, ...base, code: "subcommand_not_allowed", detail: `"${program}" requires a read-only subcommand as the first argument (no leading flags)` };
    if (!(rule.readOnlySubcommands ?? []).includes(sub)) {
      return { ok: false, ...base, code: "subcommand_not_allowed", detail: `"${program} ${sub}" is not a permitted read-only subcommand; allowed: ${(rule.readOnlySubcommands ?? []).join(", ")}` };
    }
  }

  if (rule.deniedArgTokens !== undefined) {
    const bad = args.find((a) => argDenied(a, rule.deniedArgTokens!));
    if (bad !== undefined) return { ok: false, ...base, code: "denied_argument", detail: `argument "${bad}" is not permitted for "${program}" (it could write or escape)` };
  }

  return { ok: true, ...base };
}

// ---------------------------------------------------------------------------
// CWD confinement (pure precheck)
// ---------------------------------------------------------------------------

/** A pure, filesystem-free precheck on a model-supplied relative cwd. The runtime does the
 *  authoritative realpath containment; this rejects the obvious escapes early. */
export function validateRelativeCwd(cwd: string): { readonly ok: true; readonly normalized: string } | { readonly ok: false; readonly detail: string } {
  const raw = cwd.trim();
  if (raw.length === 0 || raw === ".") return { ok: true, normalized: "." };
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return { ok: false, detail: `cwd must be workspace-relative, not an absolute path ("${cwd}")` };
  const segments = raw.split(/[\\/]+/);
  if (segments.some((s) => s === "..")) return { ok: false, detail: `cwd must not contain ".." ("${cwd}")` };
  return { ok: true, normalized: segments.filter((s) => s.length > 0 && s !== ".").join("/") || "." };
}

// ---------------------------------------------------------------------------
// Output bounding
// ---------------------------------------------------------------------------

export interface BoundedOutput {
  readonly excerpt: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}

/**
 * Bound a command's combined output: hash the FULL text (so the record can prove what was
 * produced), then keep a bounded TAIL excerpt (a failing command's diagnostics live at the
 * end). No model summarizer — just head/tail truncation.
 */
export function boundCommandOutput(full: string, maxBytes: number): BoundedOutput {
  const byteLength = Buffer.byteLength(full, "utf8");
  const digest = sha256(full);
  if (byteLength <= maxBytes) return { excerpt: full, sha256: digest, byteLength, truncated: false };
  // Keep the tail (diagnostics), decoded from a byte-bounded slice.
  const buf = Buffer.from(full, "utf8");
  const excerpt = buf.subarray(buf.length - maxBytes).toString("utf8");
  return { excerpt, sha256: digest, byteLength, truncated: true };
}

// ---------------------------------------------------------------------------
// Command record
// ---------------------------------------------------------------------------

export type V2CommandId = V2Digest<"builder_command">;

/** How the command was executed at the OS boundary — recorded for the receipt. */
export type CommandSandboxMode = "sandboxed_read_only" | "unsandboxed_read_only";

/**
 * The immutable account of ONE builder command. Binds the request, the policy, the exact
 * before/after candidate tree, and the bounded output — NEVER an absolute temp path, a
 * credential, or the full output stream. `workspaceMutated` MUST be false for a valid Option-A
 * result; the runtime turns a true into a hard safety failure instead of a record.
 */
export interface BuilderCommandRecord {
  readonly commandId: V2CommandId;
  readonly runId: string;
  readonly ordinal: number;
  readonly commandPolicyId: V2CommandPolicyId;
  readonly program: string;
  readonly args: readonly string[];
  /** Workspace-relative cwd. Never absolute. */
  readonly cwd: string;
  readonly workspaceAccess: CommandWorkspaceAccess;
  readonly network: CommandNetworkPolicy;
  readonly sandboxMode: CommandSandboxMode;
  /** Did the command actually launch? False for a policy/allowlist denial (nothing ran). */
  readonly launched: boolean;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
  readonly durationMs: number;
  readonly outputSha256: string;
  readonly outputExcerpt: string;
  readonly outputByteLength: number;
  readonly outputTruncated: boolean;
  /** The candidate tree hash before and after — the authoritative read-only proof. */
  readonly treeBefore: string;
  readonly treeAfter: string;
  /** ALWAYS false for a valid result; a true would already have become a safety failure. */
  readonly workspaceMutated: boolean;
}

/**
 * Build the content-addressed command record. Identity is the run + ordinal + exact request +
 * policy + observed effect — NOT the clock and NOT any absolute path, so one command event can
 * never be confused with another while temp paths and timings stay out of the identity.
 */
export function buildCommandRecord(input: {
  readonly runId: V2RunId;
  readonly ordinal: number;
  readonly policyId: V2CommandPolicyId;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly workspaceAccess: CommandWorkspaceAccess;
  readonly network: CommandNetworkPolicy;
  readonly sandboxMode: CommandSandboxMode;
  readonly launched: boolean;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
  readonly durationMs: number;
  readonly output: BoundedOutput;
  readonly treeBefore: string;
  readonly treeAfter: string;
}): BuilderCommandRecord {
  const semantic = {
    runId: input.runId,
    ordinal: input.ordinal,
    commandPolicyId: input.policyId,
    program: input.program,
    args: [...input.args],
    cwd: input.cwd,
    workspaceAccess: input.workspaceAccess,
    network: input.network,
    sandboxMode: input.sandboxMode,
    launched: input.launched,
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    timedOut: input.timedOut,
    timeoutMs: input.timeoutMs,
    outputSha256: input.output.sha256,
    outputByteLength: input.output.byteLength,
    outputTruncated: input.output.truncated,
    treeBefore: input.treeBefore,
    treeAfter: input.treeAfter,
    workspaceMutated: false,
  };
  return Object.freeze({
    commandId: contentDigest("builder_command", { runId: input.runId, ordinal: input.ordinal, program: input.program, args: [...input.args], cwd: input.cwd, policyId: input.policyId, treeBefore: input.treeBefore, outputSha256: input.output.sha256 }),
    ...semantic,
    // durationMs is provenance (excluded from identity) but kept on the record.
    durationMs: input.durationMs,
    outputExcerpt: input.output.excerpt,
  });
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_COMMAND_FAILURE_CODES = {
  /** A command changed the candidate tree — the primary invariant was breached. Hard stop. */
  workspaceMutated: "build.command_workspace_mutated",
  /** The command count budget for one candidate was exhausted. */
  commandBudgetExhausted: "build.command_budget_exhausted",
} as const;

/** The HARD SAFETY FAILURE for a command that changed the candidate tree. Never retryable. */
export function commandWorkspaceMutatedFailure(detail: { readonly program: string; readonly treeBefore: string; readonly treeAfter: string }): RunFailure {
  return runFailure({
    category: "build",
    code: V2_COMMAND_FAILURE_CODES.workspaceMutated,
    message: `a builder command ("${detail.program}") changed the candidate tree — commands are read-only and this is a safety violation; the build is stopped`,
    stage: "candidate_generation",
    retryable: false,
    detail: { program: detail.program, treeBefore: detail.treeBefore, treeAfter: detail.treeAfter },
  });
}

// ---------------------------------------------------------------------------
// Tool outcomes (pure builders) + the capability seam
// ---------------------------------------------------------------------------

/** Build the `command` ToolOutcome for a request REFUSED before it ran (policy/allowlist/cwd). */
export function commandRefusalOutcome(input: { readonly program: string; readonly args: readonly string[]; readonly cwd: string; readonly code: string; readonly detail: string }): ToolOutcome {
  return {
    kind: "command",
    program: input.program,
    args: [...input.args],
    cwd: input.cwd,
    launched: false,
    refused: true,
    refusalCode: input.code,
    timedOut: false,
    workspaceUnchanged: true,
    outputSha256: sha256(""),
    outputByteLength: 0,
    outputTruncated: false,
    untrusted: input.detail,
  };
}

/** Build the `command` ToolOutcome for a command that ran (any exit code). Read-only proven. */
export function commandLaunchedOutcome(record: BuilderCommandRecord): ToolOutcome {
  return {
    kind: "command",
    program: record.program,
    args: [...record.args],
    cwd: record.cwd,
    launched: record.launched,
    refused: false,
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    timedOut: record.timedOut,
    workspaceUnchanged: record.treeBefore === record.treeAfter,
    outputSha256: record.outputSha256,
    outputByteLength: record.outputByteLength,
    outputTruncated: record.outputTruncated,
    untrusted: record.outputExcerpt,
  };
}

/** One builder command request handed to the capability. */
export interface BuilderCommandRequest {
  readonly runId: V2RunId;
  readonly workspacePath: string;
  readonly ordinal: number;
  readonly program: string;
  readonly args: readonly string[];
  /** Model-supplied, workspace-relative cwd (unvalidated here — the capability confines it). */
  readonly cwd: string;
}

/** What the capability returns: the model-facing outcome, the record, and any HARD safety stop. */
export interface BuilderCommandResult {
  readonly outcome: ToolOutcome;
  /** Present when the command ran (launched or refused-by-policy still yields a record of the request). */
  readonly command?: BuilderCommandRecord;
  /** Present ONLY on a tree-mutation safety violation — the builder MUST abort the build. */
  readonly safetyFailure?: RunFailure;
}

/**
 * THE builder terminal capability. Implemented in runtime/command-executor.ts (it holds the
 * governed executor and the tree prober). Declared here so the pure builder layer can wire it
 * without importing any I/O.
 */
export interface BuilderCommandCapability {
  run(request: BuilderCommandRequest): Promise<BuilderCommandResult>;
}


/* ── REPEATED READ-ONLY EXPLORATION ──────────────────────────────────────────

   A real qualification spent sixteen of its twenty-four turns exploring, and three of
   those turns re-ran commands it had already run against a candidate it had not changed:
   `ls docs/` at command 1, again at 3, again at 9. Turns are the scarcest thing a builder
   has, and nothing told it.

   WHAT THIS IS NOT. It is not a cache. The command still runs, and its real output is
   still what comes back — a shell command's result is a function of a filesystem and a
   clock, and quietly replaying a stale one would be the harness lying about what
   happened. It is not advice, either: the note states a fact and stops. The builder may
   have an excellent reason to look again, and deciding that is its job.

   Model-agnostic by construction: the identity is the command and the candidate's own
   mutation epoch. Nothing here can see which model is running. */

/**
 * How many APPLIED mutations deep the candidate is.
 *
 * The narrowest possible notion of "has the state changed under me": it starts at 0 and
 * advances only when a mutation actually lands. A refused write does not move it, because
 * a refused write changed nothing. Reusing the existing mutation ledger rather than
 * inventing a tree identity keeps this from becoming a second workspace authority.
 */
export type MutationEpoch = number;

/**
 * The identity of one read-only command against one candidate state.
 *
 * Everything that could change the answer is in it: the program, the arguments in order,
 * the directory, and the epoch. Two commands with the same key asked the same question of
 * the same tree; anything else is a different question.
 */
export function commandRepeatKey(input: {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly epoch: MutationEpoch;
}): string {
  // JSON rather than a join: an argument containing the separator must not be able to
  // collide with a different argument list.
  return JSON.stringify([input.epoch, input.program, [...input.args], input.cwd]);
}

/** Where an identical earlier run of this command happened. */
export interface PriorCommandRun {
  /** The builder turn it ran on (1-based). */
  readonly turn: number;
  /** Its ordinal in this candidate's command list (1-based). */
  readonly ordinal: number;
}

/**
 * The harness-authored note appended to a repeated command's result.
 *
 * STATES A FACT AND STOPS. It does not say "do not run this again", does not suggest what
 * to do instead, and does not comment on whether the builder knows enough — all of which
 * would be the harness making the builder's decisions for it. It reports that the same
 * question was asked of the same unchanged tree, and where.
 */
export function repeatedCommandNote(prior: PriorCommandRun, mutationsSince: number): string {
  return (
    `[ikbi] This exact command already ran at turn ${prior.turn} (command ${prior.ordinal}) ` +
    `against the same candidate state — ${mutationsSince === 0 ? "no files have been changed since" : `${mutationsSince} change(s) since`}. ` +
    `It has been run again and the output above is the fresh result.`
  );
}

/**
 * `ikbi local <task>` — ask the local worker one bounded question.
 *
 * THE POINT OF A SEPARATE SURFACE. This is deliberately not `ikbi build --on-bokahli`. A build
 * mutates a repository through a governed pipeline; this asks a question and prints an answer.
 * Giving them one command would make the local worker look like a smaller builder, which is
 * exactly the thing it must not be mistaken for: it holds no tool, no workspace, and no authority
 * to change, verify, publish or promote anything.
 *
 * WHAT AN OPERATOR GETS BACK. The artifact, if a deterministic validator accepted one — and, either
 * way, the full accounting: what ikbi decided and why, which artifact actually served the request,
 * how many attempts it took, how much latency it added, and whether the answer was accepted or
 * discarded. An unqualified answer is labelled as one, every time, because on the current
 * deployment every answer is one.
 */

import { readFileSync } from "node:fs";

import { registerCommand } from "../../cli/registry.js";
import { writeStdout, writeStderr } from "../../cli/io.js";
import { LOCAL_MODES, type LocalMode } from "../core/local-work.js";
import { runLocalLane, type LocalLaneResult, type LocalPacketItem, type LocalValidator } from "../runtime/local-lane.js";
import { LOCAL_VALIDATORS, type LocalValidatorName } from "../runtime/local-validators.js";
import { createUntrustedBoundary } from "../runtime/untrusted-boundary.js";
import { productionTransport } from "../runtime/index.js";
import type { InvocationTransport } from "../core/invocation.js";

export const LOCAL_USAGE =
  'Usage: ikbi local <task-class> --instruction "<question>" [--file <path>]... [--mode assist|auto|off|exact]\n' +
  "                 [--model <artifact-id>] [--digest <sha256:...>] [--require-qualified] [--json]\n\n" +
  `Task classes: ${Object.keys(LOCAL_VALIDATORS).join(", ")}\n` +
  "Every --file is read, bounded, and FENCED as untrusted evidence before it reaches the model.\n" +
  "The local worker receives no tools and cannot change, verify, publish or promote anything.";

interface LocalArgs {
  readonly taskClass: string;
  readonly instruction: string;
  readonly files: readonly string[];
  readonly mode: LocalMode;
  readonly model?: string;
  readonly digest?: string;
  readonly requireQualified: boolean;
  readonly json: boolean;
  readonly rejection?: string;
}

/** Parse, refusing anything ambiguous rather than guessing. */
export function parseLocalArgs(argv: readonly string[]): LocalArgs {
  const base = { taskClass: "", instruction: "", files: [] as string[], mode: "assist" as LocalMode, requireQualified: false, json: false };
  const files: string[] = [];
  let taskClass = "";
  let instruction = "";
  let mode: LocalMode = "assist";
  let model: string | undefined;
  let digest: string | undefined;
  let requireQualified = false;
  let json = false;
  const bad = (rejection: string): LocalArgs => ({ ...base, files, taskClass, instruction, mode, requireQualified, json, rejection });

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = (): string | undefined => argv[++i];
    if (a === "--instruction") { const v = next(); if (v === undefined) return bad("--instruction needs a value"); instruction = v; continue; }
    if (a === "--file") { const v = next(); if (v === undefined) return bad("--file needs a path"); files.push(v); continue; }
    if (a === "--mode") {
      const v = next();
      if (v === undefined || !(LOCAL_MODES as readonly string[]).includes(v)) return bad(`--mode must be one of ${LOCAL_MODES.join("|")}`);
      mode = v as LocalMode; continue;
    }
    if (a === "--model") { const v = next(); if (v === undefined) return bad("--model needs an artifact id"); model = v; continue; }
    if (a === "--digest") { const v = next(); if (v === undefined) return bad("--digest needs a value"); digest = v; continue; }
    if (a === "--require-qualified") { requireQualified = true; continue; }
    if (a === "--json") { json = true; continue; }
    if (a.startsWith("--")) return bad(`unknown flag ${a}`);
    if (taskClass === "") { taskClass = a; continue; }
    return bad(`unexpected argument ${JSON.stringify(a)} — the question goes in --instruction`);
  }

  if (taskClass === "") return bad("a task class is required");
  if (!Object.prototype.hasOwnProperty.call(LOCAL_VALIDATORS, taskClass)) {
    return bad(`unknown task class ${JSON.stringify(taskClass)} — every local task needs a deterministic validator`);
  }
  if (instruction === "") return bad("--instruction is required — a local worker answers a question, not a vibe");
  // EXACT means the operator named the artifact. Without one there is nothing exact about it.
  if (mode === "exact" && model === undefined) return bad("--mode exact requires --model");
  return { taskClass, instruction, files, mode, ...(model !== undefined ? { model } : {}), ...(digest !== undefined ? { digest } : {}), requireQualified, json };
}

export interface LocalCliIo {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly readFile?: (path: string) => string;
  readonly runLane?: typeof runLocalLane;
  readonly makeTransport?: () => InvocationTransport | undefined;
}

/** Render a result for a human. The accounting is not optional detail; it IS the deliverable. */
export function renderLocalResult(r: LocalLaneResult): string {
  const lines = [
    `decision    ${r.decision.offload ? "OFFLOAD" : "KEEP LOCAL WORK OFF"} — ${r.decision.reason}`,
    `            ${r.decision.explanation}`,
  ];
  if (r.servedIdentity !== undefined) {
    lines.push(
      `served by   ${r.servedIdentity.modelId}`,
      `            digest ${r.servedIdentity.artifactDigest}`,
      `            qualification ${r.servedIdentity.qualificationStatus}`,
    );
  }
  if (r.attempts.length > 0) {
    const tokens = r.attempts.reduce((n, a) => n + (a.promptTokens ?? 0) + (a.completionTokens ?? 0), 0);
    const wall = r.attempts.reduce((n, a) => n + a.latencyMs, 0);
    lines.push(`attempts    ${r.attempts.length} (${r.retryCount} retry/retries), ${wall}ms local + ${r.addedLatencyMs}ms backoff, ${tokens} local token(s)`);
  }
  if (r.accepted) {
    lines.push(`result      ACCEPTED by its deterministic validator`);
    if (r.supervision !== undefined && !r.supervision.qualified) {
      // Said plainly, every time. On the current deployment this is every answer.
      lines.push(
        `            SUPERVISED-LOCAL — unqualified artifact. Human review required;`,
        `            this result may not be promoted autonomously. ${r.supervision.reason}`,
      );
    }
    lines.push("", JSON.stringify(r.artifact, null, 2));
  } else {
    lines.push(`result      NOT ACCEPTED — ${r.rejection ?? r.decision.reason}`, `            ${r.detail}`);
    if (r.partialOutputDiscarded) lines.push(`            partial local output was DISCARDED`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runLocalCli(argv: readonly string[], io: LocalCliIo = {}): Promise<number> {
  const out = io.stdout ?? writeStdout;
  const err = io.stderr ?? writeStderr;
  const args = parseLocalArgs(argv);
  if (args.rejection !== undefined) {
    // REFUSE BEFORE ANYTHING IS CONSTRUCTED. An invocation we cannot read is never close enough.
    err(`ikbi local: ${args.rejection}\n\n${LOCAL_USAGE}\n`);
    return 2;
  }

  const readFile = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const packet: LocalPacketItem[] = [];
  const seen = new Set<string>();
  for (const f of args.files) {
    try {
      // A SHORT, UNIQUE id. The model has to reproduce this exactly for a citation to resolve, and
      // a long absolute path is both hard to copy and easy to confuse with the fence's own origin
      // marker. Collisions get a numeric suffix rather than silently merging two files.
      const base = f.split("/").pop() ?? f;
      let id = base;
      for (let n = 2; seen.has(id); n += 1) id = `${base}#${n}`;
      seen.add(id);
      packet.push({ id, content: readFile(f), source: "repo" });
    } catch (e) {
      err(`ikbi local: cannot read ${f}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
  }
  if (packet.length === 0) {
    err("ikbi local: at least one --file is required — a local worker answers from a packet, never from a repository\n");
    return 2;
  }

  const validator: LocalValidator = LOCAL_VALIDATORS[args.taskClass as LocalValidatorName];
  // THE ONE TRANSPORT. The lane calls a model exactly the way the builder does; `productionTransport`
  // resolves Bokahli by id through the decorated lookup, lazily, so a machine with no Bokahli
  // reaches the "not configured" DECISION rather than a credential error on a command it never ran.
  const transport = (io.makeTransport ?? (() => {
    try {
      return productionTransport();
    } catch {
      return undefined;
    }
  }))();

  const result = await (io.runLane ?? runLocalLane)(
    {
      mode: args.mode,
      taskClass: args.taskClass,
      instruction: args.instruction,
      packet,
      validator,
      requireQualified: args.requireQualified,
      // Attestation is required whenever the operator named a target: an EXACT request that
      // accepts an unattested answer has not been exact about anything.
      requireAttestation: args.model !== undefined || args.digest !== undefined,
      ...(args.model !== undefined ? { expectedModelId: args.model } : {}),
      ...(args.digest !== undefined ? { expectedDigest: args.digest } : {}),
    },
    { ...(transport !== undefined ? { transport } : {}), boundary: createUntrustedBoundary() },
  );

  out(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderLocalResult(result));
  // A refusal is an ANSWER, and an operator scripting this needs to tell it from an acceptance.
  return result.accepted ? 0 : 1;
}

registerCommand({
  name: "local",
  summary: "Ask the local worker (Bokahli) one bounded, validated question — never mutates, never promotes",
  usage: LOCAL_USAGE,
  category: "advanced",
  run: async (argv) => {
    const code = await runLocalCli(argv);
    if (code !== 0) process.exitCode = code;
  },
});

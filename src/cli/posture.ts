/**
 * ikbi PRODUCT POSTURE — the single shared status object the operator-facing surfaces read.
 *
 * Phase 1 of the spine consolidation: `doctor`, the REPL `/status` command, the CLI
 * `capabilities` command, and the HTTP `/capabilities` endpoint all reported (or omitted)
 * lifecycle facts independently, so they could drift and overstate what a path guarantees.
 * This module is the ONE place that answers "for each operator-facing surface, which spine
 * guarantees does it actually provide, and how is it classified relative to the golden path?"
 *
 * It is PURE over its inputs (singletons by default), so every consumer renders the SAME truth
 * and the truth is unit-testable without touching the model. The classifications come straight
 * from docs/PRODUCT-SPINE.md; the lifecycle booleans encode the durable runtime reality of each
 * path (see docs/ARCHITECTURE-INVARIANTS.md — "interface invariants").
 */

import {
  resolveRetrievalMode,
  resolveVerificationMode,
  safetyPosture,
  type RetrievalMode,
  type SafetyPosture,
  type VerificationMode,
} from "../modules/worker-model/modes.js";
import { runCapabilities, type CapabilitiesResult } from "./capabilities.js";

/**
 * How a surface relates to the golden build path. Mapped from docs/PRODUCT-SPINE.md:
 *  - core        — on the daily coding loop / promotion lifecycle.
 *  - adapter     — CLI/HTTP/TUI glue over core behavior, with the same semantics.
 *  - experimental— a "dangerous parallel path": an alternate edit/exec/route loop with WEAKER
 *                  guarantees than the golden path (PRODUCT-SPINE "Dangerous parallel path").
 *  - dormant     — a typed surface that is imported/tested but has no default operator path.
 */
export type SurfaceClass = "core" | "adapter" | "experimental" | "dormant";

/** One operator-facing surface and its honest classification. */
export interface SurfaceClassification {
  readonly surface: string;
  readonly classification: SurfaceClass;
  readonly note: string;
}

/**
 * Per-surface lifecycle truth — which spine guarantees a path actually delivers. Each boolean is
 * the answer to a "yes/no" the operator must be able to trust before relying on the path:
 *  - persistentSessions — can a session be resumed across a process restart?
 *  - managedWorkspace   — do edits flow through a managed, promotable worktree (not live-direct)?
 *  - rollbackDurability — is EVERY mutation the path makes durably reversible (incl. terminal/sub-agent)?
 *  - verificationPath   — does the path gate "success" on objective verification evidence?
 *  - promoteApplyPath   — is there an explicit, governed promote/apply step?
 */
export interface LifecyclePosture {
  readonly persistentSessions: boolean;
  readonly managedWorkspace: boolean;
  readonly rollbackDurability: boolean;
  readonly verificationPath: boolean;
  readonly promoteApplyPath: boolean;
}

/** The full product posture: safety, tool parity, surface classifications, and per-surface lifecycle. */
export interface ProductPosture {
  readonly safety: {
    readonly verification: VerificationMode;
    readonly retrieval: RetrievalMode;
    readonly posture: SafetyPosture;
  };
  readonly toolParity: {
    readonly builder: number;
    readonly chat: number;
    readonly inSync: boolean;
  };
  readonly classifications: readonly SurfaceClassification[];
  /** Lifecycle truth keyed by surface. `build` is the reference golden path (all guarantees). */
  readonly lifecycle: {
    readonly build: LifecyclePosture;
    readonly replChat: LifecyclePosture;
    readonly httpChat: LifecyclePosture;
  };
  /** HTTP /chat persistence disclosure (mirrors the chat contract's ephemeral fields). */
  readonly chatSessions: {
    readonly persistence: "ephemeral";
    readonly resumable: false;
    readonly warning: string;
  };
}

export interface PostureInputs {
  /** Env source for verification/retrieval mode resolution (tests inject). Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Tool-parity source; defaults to the live builder/chat tool arrays. */
  readonly capabilities?: CapabilitiesResult;
}

/** The golden build path — the reference spine that provides every lifecycle guarantee. */
const BUILD_LIFECYCLE: LifecyclePosture = {
  persistentSessions: true, // durable worktree records + receipts survive restarts
  managedWorkspace: true, // edits land in isolated git worktrees, never the target tree directly
  rollbackDurability: true, // retain/discard/undo operate on durable workspace records
  verificationPath: true, // ladder verification gates success on objective evidence
  promoteApplyPath: true, // gate-wall promotion is explicit and receipt-backed
};

/**
 * REPL chat — Phase 2 gave repo mode a MANAGED workspace (isolated worktree, governed `/apply`
 * promote, safe `/discard`). Phase 3 closes the verification gap: managed `/apply` now runs the SAME
 * ladder verification `ikbi build` uses and promotes ONLY on a pass. This records the DEFAULT (repo)
 * mode truth — `--scratch` and HTTP `/chat` remain non-managed / non-promotable (and so cannot
 * verify-or-apply at all). The verification figure is therefore CONDITIONAL: it is the truth for the
 * one repl path that can actually promote.
 */
const REPL_CHAT_LIFECYCLE: LifecyclePosture = {
  persistentSessions: true, // disk-backed session store (`ikbi repl --continue`/`--resume`)
  managedWorkspace: true, // repo mode edits an isolated managed worktree, never the target directly
  rollbackDurability: true, // edits stay in the workspace until /apply; /discard drops them safely; post-apply `ikbi undo`
  verificationPath: true, // Phase 3: managed /apply runs ladder verification before promoting (scratch can't apply)
  promoteApplyPath: true, // explicit operator /apply runs the governed, receipt-backed workspace promote
};

/** HTTP /chat — like REPL chat but the session itself is in-memory and does not survive a restart. */
const HTTP_CHAT_LIFECYCLE: LifecyclePosture = {
  persistentSessions: false, // in-memory, LRU-evicted, lost on restart (ephemeral)
  managedWorkspace: false,
  rollbackDurability: false,
  verificationPath: false,
  promoteApplyPath: false,
};

const HTTP_EPHEMERAL_WARNING =
  "POST /chat sessions are in-memory only and do not survive server restart; use `ikbi repl --continue` for durable sessions.";

/**
 * Surface classifications, lifted verbatim from docs/PRODUCT-SPINE.md. Every path the operator can
 * reach to edit/route/execute is named here so none can claim golden-path semantics implicitly.
 */
const CLASSIFICATIONS: readonly SurfaceClassification[] = [
  { surface: "build (CLI)", classification: "core", note: "the golden path — managed workspace, ladder verification, governed promote/undo." },
  { surface: "repl chat", classification: "experimental", note: "repo mode uses a managed workspace; /apply runs ladder verification then a governed promote (Phase 3). Conditional: only the managed path can verify+apply — --scratch is non-promotable." },
  { surface: "http /chat", classification: "experimental", note: "HTTP coding loop; ephemeral (in-memory) scratch sessions — non-managed, non-promotable (deliberately deferred)." },
  { surface: "mcp loop", classification: "experimental", note: "separate stdio model/tool loop; not the golden build path." },
  { surface: "batch", classification: "experimental", note: "multi-run orchestration that can diverge from single-build behavior." },
  { surface: "sub-agent spawn", classification: "dormant", note: "typed spawn surface; no default operator path exercises it." },
  { surface: "bare-goal cognition", classification: "experimental", note: "bare-goal deliberation/auto-dispatch can route before operator clarity." },
];

/** Build the product posture. Pure over its inputs (process-wide singletons by default). */
export function productPosture(inp: PostureInputs = {}): ProductPosture {
  const env = inp.env ?? process.env;
  const caps = inp.capabilities ?? runCapabilities();
  // `ikbi build` runs the PRODUCTION wiring, so report the production-resolved modes (the ones an
  // operator actually gets), exactly as doctor does.
  const verification = resolveVerificationMode(env, { production: true });
  const retrieval = resolveRetrievalMode(env, { production: true });

  return {
    safety: { verification, retrieval, posture: safetyPosture(verification, retrieval) },
    toolParity: {
      builder: caps.builder.length,
      chat: caps.chat.length,
      inSync: caps.builderOnly.length === 0 && caps.chatOnly.length === 0,
    },
    classifications: CLASSIFICATIONS,
    lifecycle: { build: BUILD_LIFECYCLE, replChat: REPL_CHAT_LIFECYCLE, httpChat: HTTP_CHAT_LIFECYCLE },
    chatSessions: { persistence: "ephemeral", resumable: false, warning: HTTP_EPHEMERAL_WARNING },
  };
}

const YES = "✓";
const NO = "✗";

/** One-line lifecycle disclosure: surface label + each guarantee as ✓/✗. */
function lifecycleLine(label: string, l: LifecyclePosture): string {
  const flags = [
    `${l.persistentSessions ? YES : NO} persistent`,
    `${l.managedWorkspace ? YES : NO} managed-workspace`,
    `${l.rollbackDurability ? YES : NO} durable-rollback`,
    `${l.verificationPath ? YES : NO} verification`,
    `${l.promoteApplyPath ? YES : NO} promote/apply`,
  ];
  return `  ${label.padEnd(13)} ${flags.join(" · ")}`;
}

/**
 * Render the posture as operator-readable lines (shared by the CLI `capabilities` command and
 * doctor). Discloses BOTH the surface classifications and the per-surface lifecycle truth, so no
 * caller can present a weaker path as if it had golden-path guarantees.
 */
export function postureLines(p: ProductPosture = productPosture()): string[] {
  const lines: string[] = [];
  lines.push("Product surfaces (classification — relative to the golden build path):");
  for (const c of p.classifications) lines.push(`  ${c.surface.padEnd(20)} ${c.classification.toUpperCase().padEnd(13)} ${c.note}`);
  lines.push("");
  lines.push("Lifecycle truth (which spine guarantees each editing surface actually provides):");
  lines.push(lifecycleLine("build (CLI)", p.lifecycle.build));
  lines.push(lifecycleLine("repl chat", p.lifecycle.replChat));
  lines.push(lifecycleLine("http /chat", p.lifecycle.httpChat));
  lines.push("  note: repl 'managed' figures are for the DEFAULT repo mode; `ikbi repl --scratch` is non-managed / non-promotable (no verify/apply).");
  lines.push("  note: repl chat verification is CONDITIONAL — managed /apply runs ladder verification before promoting; the build path additionally runs scout/critic/integrator.");
  lines.push(`  note: http /chat sessions are EPHEMERAL — ${p.chatSessions.warning}`);
  return lines;
}

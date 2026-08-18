/**
 * THE GOVERNED CHECK RUNNER — v1's governed-exec, behind the v2 seam.
 *
 * Verification commands run through the SAME execution authority as everything else in
 * ikbi, not a private spawn: `governed-exec` gates every command through the default-deny
 * binary allowlist and the gate-wall, confines its filesystem writes to the candidate
 * worktree via the F1 OS sandbox, denies network by default, and receipts the run. This
 * is NOT the builder terminal tool — the model never reaches it. It is an infrastructure
 * authority executing a PREDECLARED plan of named commands.
 *
 * IDENTITY. governed-exec refuses a command whose caller does not present a genuinely
 * minted `ValidatedIdentity` (anti-spoof). This adapter mints its OWN, self-contained: a
 * single-agent registry with a fresh random token, resolved once. It borrows no operator
 * credential and grants no authority beyond running the allowlisted check binaries under
 * `verifier: true` (which authorizes package SCRIPTS — `pnpm test` — and nothing a model
 * could set).
 *
 * DEFENCE IN DEPTH, NOT THE PROOF. The sandbox's write-confinement and network-deny are
 * real and valuable, but the AUTHORITATIVE guarantee that a check did not alter the
 * candidate is v2's own tree recheck (before == after), which holds even where the sandbox
 * is unavailable. The two are complementary: the sandbox makes mutation unlikely, the
 * recheck makes an undetected mutation impossible.
 *
 * MAPPING governed-exec's `ExecResult` to the seam's `CheckExecution`:
 *   executed:true, exitCode 124  → timed out (the streaming path stamps 124 on a kill);
 *   executed:true, other exit    → launched, that exit code;
 *   executed:false               → NOT launched (denied binary / gate deny / dry-run) —
 *                                  the verifier classifies this as infrastructure_failure,
 *                                  never as a candidate FAIL, because the check never ran.
 */

import { createHash, randomBytes } from "node:crypto";

import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { IdentityResolver, beginOperation } from "../../core/identity/resolver.js";
import pino from "pino";
import { createGovernedExec } from "../../modules/governed-exec/index.js";
import type { GovernedExec } from "../../modules/governed-exec/index.js";
import type { OperationContext } from "../../core/identity/index.js";
import type { CheckExecution, CheckRunner } from "../core/verification.js";

/** The conventional timeout-kill exit code governed-exec's streaming path stamps. */
const TIMEOUT_EXIT_CODE = 124;

/** Bounded excerpt kept from a check's output for the record. Never the whole stream. */
const MAX_EXCERPT_CHARS = 1_500;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Mint a self-contained, deterministic-system operation context for the verifier.
 *
 * A one-agent registry with a fresh random token, resolved once. Nothing else on the box
 * knows the token, so this identity cannot be presented by anything but this adapter, and
 * it borrows no operator or worker credential.
 */
function mintVerifierContext(): OperationContext {
  const token = randomBytes(32).toString("hex");
  const registry = new AgentRegistry({
    agents: [{ agentId: "ikbi-v2-verifier", kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken(token)] }],
  });
  const resolver = new IdentityResolver({ registry, logger: pino({ enabled: false }) });
  return beginOperation(resolver.resolve({ token }), { requestId: `v2-verify-${randomBytes(4).toString("hex")}` });
}

export interface CheckRunnerDeps {
  /** Test seam. Production builds the live governed executor. */
  readonly governedExec?: Pick<GovernedExec, "run">;
  readonly now?: () => number;
}

/**
 * Build THE governed check runner.
 *
 * One minted identity and one governed executor per instance. The executor is the live
 * default wiring (real gate-wall + config + OS sandbox), constructed lazily so importing
 * this module does not stand up the whole execution stack.
 */
export function createCheckRunner(deps: CheckRunnerDeps = {}): CheckRunner {
  const now = deps.now ?? Date.now;
  const parentCtx = mintVerifierContext();
  let exec: Pick<GovernedExec, "run"> | undefined = deps.governedExec;
  const executor = (): Pick<GovernedExec, "run"> => (exec ??= createGovernedExec());

  return {
    async run(input): Promise<CheckExecution> {
      const startedAt = now();
      let full = "";
      const res = await executor().run({
        parentCtx,
        command: input.command,
        args: [...input.args],
        cwd: input.cwd,
        // The OS sandbox keeps THIS worktree writable and the host read-only (F1).
        worktreeRoot: input.cwd,
        // Trusted check-runner — may run package scripts. A model cannot set this.
        verifier: true,
        purpose: `v2 verification check: ${input.name}`,
        timeoutMs: input.timeoutMs,
        // Stream so a verbose suite's exit code survives (buffered capture can ENOBUFS to
        // a false non-zero); we accumulate the full output only to hash + excerpt it.
        onOutput: (chunk) => { full += chunk; },
      });
      const durationMs = now() - startedAt;

      if (!res.executed) {
        // Denied binary, gate deny, or dry-run: the check NEVER RAN. Report it as not
        // launched so the verifier classifies infrastructure_failure, not a candidate fail.
        const reason = res.denied === true ? `denied: ${res.reason ?? "not allowlisted"}` : `not executed: ${res.reason ?? "dry-run"}`;
        return { launched: false, timedOut: false, durationMs, outputSha256: sha256(full), outputExcerpt: excerpt(full), refusedReason: reason };
      }

      const exitCode = res.exitCode ?? 1;
      const timedOut = exitCode === TIMEOUT_EXIT_CODE;
      return {
        launched: true,
        exitCode,
        timedOut,
        durationMs,
        outputSha256: sha256(full),
        outputExcerpt: excerpt(full),
      };
    },
  };
}

function excerpt(text: string): string {
  return text.length <= MAX_EXCERPT_CHARS ? text : text.slice(text.length - MAX_EXCERPT_CHARS);
}

/**
 * ikbi `doctor` — a read-only bootstrap config self-check.
 *
 * Reads the already-parsed config (core + the relevant module configs) and reports,
 * grouped, which bootstrap settings are SET / MISSING / INSECURE-DEFAULT — so an agent
 * or operator driving cold can run ONE command to see "here's what's configured, here's
 * what's missing for a build, here's how to fix each gap", instead of discovering gaps
 * one failed run at a time.
 *
 * SECURITY: doctor reports STATUS ONLY — never a secret VALUE. Tokens and keys are
 * shown as set/unset, never printed. It needs no identity and no network (config only),
 * so it works BEFORE tokens are configured (which is the point).
 */

import { config, type IkbiConfig } from "../core/config.js";
import { egressConfig } from "../modules/egress/config.js";
import { governedExecConfig } from "../modules/governed-exec/config.js";
import { workerModelConfig } from "../modules/worker-model/config.js";

/** The inputs doctor reads — all default to the process-wide singletons; injectable for tests. */
export interface DoctorInputs {
  readonly config?: IkbiConfig;
  readonly workerModelEnabled?: boolean;
  readonly governedExecAllowlist?: readonly string[];
  readonly egressAllowlist?: readonly string[];
  readonly egressLocalEndpoints?: readonly string[];
}

export interface DoctorResult {
  readonly lines: readonly string[];
  readonly ready: boolean;
  readonly missingRequired: number;
}

const OK = "✓";
const BAD = "✗";
const WARN = "⚠";

/** The binary the verifier needs to run tsc/tests (the build's quality gate). */
const REQUIRED_EXEC = "pnpm";

/** Build the doctor report. Pure over its inputs (singletons by default). */
export function runDoctor(inp: DoctorInputs = {}): DoctorResult {
  const cfg = inp.config ?? config;
  const workerEnabled = inp.workerModelEnabled ?? workerModelConfig.enabled;
  const execAllow = inp.governedExecAllowlist ?? governedExecConfig.allowlist;
  const egressAllow = inp.egressAllowlist ?? egressConfig.allowlist;
  const egressLocal = inp.egressLocalEndpoints ?? egressConfig.localEndpoints;

  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  // --- REQUIRED FOR A BUILD ------------------------------------------------
  const operatorSet = cfg.identity.operatorToken !== undefined && cfg.identity.operatorToken.length > 0;
  const workerSet = cfg.identity.workerToken !== undefined && cfg.identity.workerToken.length > 0;
  const execHasPnpm = execAllow.includes(REQUIRED_EXEC);
  const providerConfigured =
    cfg.provider.mimo.apiKey !== undefined ||
    cfg.provider.openrouter.apiKey !== undefined ||
    cfg.provider.deepseek.apiKey !== undefined ||
    egressLocal.length > 0; // a keyless local model (e.g. Ollama) reached via an allowed local endpoint

  const required: Array<{ ok: boolean; label: string; fix: string }> = [
    { ok: operatorSet, label: "IKBI_OPERATOR_TOKEN", fix: "set it — the operator identity that grants trust / runs operator commands" },
    { ok: workerSet, label: "IKBI_WORKER_TOKEN", fix: "set it — the worker identity that builds run under" },
    { ok: workerEnabled, label: "IKBI_WORKER_MODEL_ENABLED", fix: "set true — builds are DISABLED until the worker-model substrate is enabled" },
    { ok: execHasPnpm, label: `IKBI_GOVERNED_EXEC_ALLOWLIST (has ${REQUIRED_EXEC})`, fix: `add "${REQUIRED_EXEC}" — the verifier needs it to run tsc/tests` },
    { ok: providerConfigured, label: "a model provider configured", fix: "set a provider API key (IKBI_MIMO_API_KEY / OpenRouter / DeepSeek) OR allow a local endpoint (IKBI_EGRESS_ALLOW_LOCAL) for a keyless local model" },
  ];

  push("REQUIRED FOR A BUILD");
  let missingRequired = 0;
  for (const r of required) {
    if (r.ok) {
      push(`  ${OK} ${r.label}`);
    } else {
      missingRequired += 1;
      push(`  ${BAD} ${r.label} — ${r.fix}`);
    }
  }

  // --- SECURITY (insecure-default warnings) --------------------------------
  push("");
  push("SECURITY");
  if (cfg.trust.hmacKeyIsDefault) {
    push(`  ${WARN} IKBI_TRUST_HMAC_KEY — unset; trust-state MAC uses an INSECURE built-in key. Set it in production.`);
  } else {
    push(`  ${OK} IKBI_TRUST_HMAC_KEY (set)`);
  }
  if (cfg.identity.tokenSaltIsDefault) {
    push(`  ${WARN} IKBI_IDENTITY_TOKEN_SALT — unset; token hashing uses an INSECURE built-in pepper. Set it in production.`);
  } else {
    push(`  ${OK} IKBI_IDENTITY_TOKEN_SALT (set)`);
  }

  // --- EGRESS --------------------------------------------------------------
  push("");
  push("EGRESS");
  push(`  ${egressAllow.length > 0 ? OK : WARN} IKBI_EGRESS_ALLOWLIST: ${egressAllow.length > 0 ? egressAllow.join(", ") : "(none — default-deny-all)"}`);
  push(`  ${egressLocal.length > 0 ? OK : "·"} IKBI_EGRESS_ALLOW_LOCAL: ${egressLocal.length > 0 ? egressLocal.join(", ") : "(none)"}`);
  push("  note: reaching a local model (e.g. Ollama) needs the host in the allowlist AND its ip:port in ALLOW_LOCAL AND a keyless provider.");

  // --- MODEL CONFIG (the ids the roles will request) -----------------------
  push("");
  push("MODEL CONFIG (resolved role models)");
  push(`  ${OK} IKBI_MODEL_DRIVER  = ${cfg.provider.defaultModels.driver}   (scout, builder)`);
  push(`  ${OK} IKBI_MODEL_CRITIC  = ${cfg.provider.defaultModels.critic}   (critic)`);

  // --- STATE ---------------------------------------------------------------
  push("");
  push("STATE");
  push(`  ${OK} IKBI_STATE_ROOT    = ${cfg.stateRoot}`);
  push(`  ${OK} trust dir          = ${cfg.trust.dir}`);
  push(`  ${OK} roster file        = ${cfg.provider.rosterFile}`);

  // --- SUMMARY -------------------------------------------------------------
  const ready = missingRequired === 0;
  push("");
  push(ready ? "ready to build" : `NOT ready — ${missingRequired} required setting${missingRequired === 1 ? "" : "s"} missing (see ${BAD} above)`);

  return { lines, ready, missingRequired };
}

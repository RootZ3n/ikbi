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
import type { ModelProvider } from "../core/provider/contract.js";
import { registry as defaultRegistry } from "../core/provider/index.js";
import type { ModelSpec } from "../core/provider/registry.js";
import { egressConfig } from "../modules/egress/config.js";
import { governedExecConfig } from "../modules/governed-exec/config.js";
import { workerModelConfig } from "../modules/worker-model/config.js";

/** The read-only registry surface doctor needs to check role-model resolution. */
export interface DoctorRegistry {
  getModel: (id: string) => ModelSpec | undefined;
  getProvider: (id: string) => ModelProvider | undefined;
}

/** The inputs doctor reads — all default to the process-wide singletons; injectable for tests. */
export interface DoctorInputs {
  readonly config?: IkbiConfig;
  readonly workerModelEnabled?: boolean;
  readonly governedExecAllowlist?: readonly string[];
  readonly egressAllowlist?: readonly string[];
  readonly egressLocalEndpoints?: readonly string[];
  /** The model registry (read-only) — to verify the role models resolve to a provider. */
  readonly registry?: DoctorRegistry;
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

  // PROVIDER readiness is the REAL question: do the role models the roles will request
  // actually RESOLVE to a registered provider? This sees roster-declared providers (the
  // MiMo keyless+api-key case), built-in keyed providers, and mixed setups — not just the
  // env-key built-ins. Read-only: getModel/getProvider, no network, no invoke.
  const reg = inp.registry ?? defaultRegistry;
  const driverId = cfg.provider.defaultModels.driver;
  const criticId = cfg.provider.defaultModels.critic;
  const resolves = (spec: ModelSpec | undefined): boolean =>
    spec !== undefined && spec.providers.some((route) => reg.getProvider(route.provider) !== undefined);
  const driverOk = resolves(reg.getModel(driverId));
  const criticOk = resolves(reg.getModel(criticId));
  const providerEntry = driverOk && criticOk
    ? { ok: true, label: `provider — driver '${driverId}' and critic '${criticId}' resolve to registered providers`, fix: "" }
    : (() => {
        const broken = [!driverOk ? `driver model '${driverId}'` : undefined, !criticOk ? `critic model '${criticId}'` : undefined].filter(
          (x): x is string => x !== undefined,
        );
        const verb = broken.length > 1 ? "don't" : "doesn't";
        return {
          ok: false,
          label: `the ${broken.join(" and ")} ${verb} resolve to a registered provider`,
          fix: "add a provider entry in the roster (providers.json) for it, or set a provider API key",
        };
      })();

  const required: Array<{ ok: boolean; label: string; fix: string }> = [
    { ok: operatorSet, label: "IKBI_OPERATOR_TOKEN", fix: "set it — the operator identity that grants trust / runs operator commands" },
    { ok: workerSet, label: "IKBI_WORKER_TOKEN", fix: "set it — the worker identity that builds run under" },
    { ok: workerEnabled, label: "IKBI_WORKER_MODEL_ENABLED", fix: "set true — builds are DISABLED until the worker-model substrate is enabled" },
    { ok: execHasPnpm, label: `IKBI_GOVERNED_EXEC_ALLOWLIST (has ${REQUIRED_EXEC})`, fix: `add "${REQUIRED_EXEC}" — the verifier needs it to run tsc/tests` },
    providerEntry,
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

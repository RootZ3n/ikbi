/**
 * ADAPTER — v1 operator/provider configuration → v2 default role models.
 *
 * The LOWEST two precedence layers, captured once so no later v2 code has an excuse to
 * reread `IKBI_MODEL_*` or a hard-coded constant on its own. v1 resolves three model
 * TIERS (`driver`, `builder`, `critic`) from env-or-builtin; v2 records both the value
 * AND whether the operator actually set it, which is the difference between
 * "operator_env" and "builtin_default" in the precedence table.
 *
 * Note `builder` in v1 falls through to `IKBI_MODEL_DRIVER` when its own var is unset.
 * That fall-through is v1's, and it is honoured here: the builder tier counts as
 * explicit when EITHER var is set, because either one is an operator decision.
 */

import type { OperatorDefaultInput, OperatorDefaultsInput } from "../core/config.js";

/** The v1 configuration surface this adapter reads. Injected so tests need no env. */
export interface OperatorDefaultsFacts {
  readonly driver: string;
  readonly builder: string;
  readonly critic: string;
}

/** Which of the tier env vars the operator actually set. */
export interface OperatorDefaultsEnv {
  readonly driverSet: boolean;
  readonly builderSet: boolean;
  readonly criticSet: boolean;
}

/** Read which tier vars are present. Reads NAMES only — never a value that could be a secret. */
export function readOperatorEnvPresence(env: NodeJS.ProcessEnv): OperatorDefaultsEnv {
  const set = (v: string | undefined): boolean => v !== undefined && v.trim().length > 0;
  return {
    driverSet: set(env.IKBI_MODEL_DRIVER),
    builderSet: set(env.IKBI_MODEL_BUILDER),
    criticSet: set(env.IKBI_MODEL_CRITIC),
  };
}

/** Normalize the three tiers into v2 defaults, tagged with their real provenance. */
export function readOperatorDefaults(facts: OperatorDefaultsFacts, env: OperatorDefaultsEnv): OperatorDefaultsInput {
  const models: OperatorDefaultInput[] = [
    { tier: "driver", modelId: facts.driver, explicit: env.driverSet },
    // v1: IKBI_MODEL_BUILDER falls through to IKBI_MODEL_DRIVER, so either var makes
    // the builder tier an explicit operator choice rather than a shipped default.
    { tier: "builder", modelId: facts.builder, explicit: env.builderSet || env.driverSet },
    { tier: "critic", modelId: facts.critic, explicit: env.criticSet },
  ];
  return { models };
}

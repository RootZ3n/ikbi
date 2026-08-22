/**
 * HERMETIC TEST TRUST MATERIAL — neutral, test-only, owned by no pipeline.
 *
 * It lives here rather than under `src/v2/` because the suites that need it are not all v2 suites:
 * `src/acceptance/` and `src/cli/` spawn the built CLI too, and the isolation guard is right that
 * v1 must not import v2 to get at a helper. Neutral shared test infrastructure belongs beside the
 * other neutral primitives, not inside one of the pipelines that happens to have needed it first.
 *
 * `src/v2/test-env.ts` re-exports this, so v2 keeps its single documented owner and its guards.
 *
 * NEVER IMPORTED BY PRODUCT RUNTIME. It mutates `process.env`; product code proving itself with a
 * test helper's environment is exactly the quiet weakening the v2 guard exists to prevent.
 */

import { randomBytes } from "node:crypto";
process.env.IKBI_ALLOW_INSECURE_DEV_KEYS ??= "true";

/**
 * THE TEST-ONLY TRUST MATERIAL, generated per process.
 *
 * WHY THIS EXISTS. `loadConfig` refuses to start on the built-in default trust MAC key and token
 * salt. The suites that SPAWN the real CLI build a deliberately sanitized child environment, so
 * that refusal fires in the child — and until now it did not, only because the child re-read the
 * operator's `.env` from the project root and picked their real keys out of it. A clean checkout
 * has no `.env`, so 191 tests failed on it while passing on the developer's machine. A suite whose
 * result depends on an untracked file in someone's home checkout is not a suite anyone can trust.
 *
 * WHAT IS PROVISIONED. Real, non-default material, so the refusal is satisfied honestly rather
 * than waived — the `IKBI_ALLOW_INSECURE_DEV_KEYS` opt-in above stays for the in-process suites
 * that construct config without one.
 *
 * GENERATED, NEVER COMMITTED. A fixed constant in the repository would be a reusable credential
 * shipped in source, and the fact that it was "only for tests" would stop being true the first
 * time somebody copied it. This is random per process, so there is nothing to leak and nothing to
 * reuse.
 *
 * DETERMINISTIC WHERE IT MATTERS. It is minted ONCE per process and shared by every child that
 * suite spawns, so identities and trust MACs stay stable across the runs within one test — which
 * is the only determinism these suites actually depend on. Two separate runs producing different
 * keys is correct: nothing durable is meant to survive between them.
 *
 * MARKED SO PRODUCTION CAN REFUSE IT. The prefix is recognizable on purpose. `core/config.ts`
 * refuses trust material carrying it unless `IKBI_HERMETIC_TEST` is set, so this material can
 * never quietly become a production trust grant — see the guard there.
 */
export const HERMETIC_TEST_KEY_PREFIX = "ikbi-test-only-";

const mintTestSecret = (label: string): string =>
  `${HERMETIC_TEST_KEY_PREFIX}${label}-${randomBytes(24).toString("hex")}`;

const HERMETIC_TRUST_HMAC_KEY = mintTestSecret("hmac");
const HERMETIC_IDENTITY_TOKEN_SALT = mintTestSecret("salt");

/**
 * The hermetic environment for a SANITIZED CHILD process.
 *
 * Those children get a deliberately minimal env (no inherited developer shell), so everything they
 * need must be injected explicitly here — the same single owner, so the in-process and child paths
 * cannot drift. `applyDotEnv` never overwrites an already-set key, so supplying these means a
 * repository `.env`, present or absent, changes nothing about how a test child starts.
 */
export const HERMETIC_DEV_KEY_ENV: Readonly<Record<string, string>> = Object.freeze({
  IKBI_ALLOW_INSECURE_DEV_KEYS: "true",
  IKBI_TRUST_HMAC_KEY: HERMETIC_TRUST_HMAC_KEY,
  IKBI_IDENTITY_TOKEN_SALT: HERMETIC_IDENTITY_TOKEN_SALT,
  // Permits the test-prefixed material above. It grants nothing on its own: without keys carrying
  // the prefix it changes no behavior, and with them it only stops production from refusing.
  IKBI_HERMETIC_TEST: "1",
});

// The IN-PROCESS suites get the same material, by the same `??=` rule: a real operator value in the
// environment always wins.
process.env.IKBI_TRUST_HMAC_KEY ??= HERMETIC_TRUST_HMAC_KEY;
process.env.IKBI_IDENTITY_TOKEN_SALT ??= HERMETIC_IDENTITY_TOKEN_SALT;
process.env.IKBI_HERMETIC_TEST ??= "1";

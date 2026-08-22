/**
 * TEST-ONLY ENVIRONMENT OPT-IN for the hermetic v2 suites (V2-019/MEDIUM-01).
 *
 * THE PROBLEM. `loadConfig` refuses to start on the built-in default trust MAC key / token salt
 * unless `IKBI_ALLOW_INSECURE_DEV_KEYS=true` is set — correctly, and that refusal fires at MODULE
 * SCOPE. Any v2 suite that imports the CLI registry (or anything else reaching core config)
 * therefore throws during import when the flag is absent, and EVERY test in the file is lost
 * before it can assert anything about v2. The suites only looked green because
 * `scripts/test-runner.sh` sets the flag for the whole run; invoked directly
 * (`node --import tsx --test src/v2/...`) ten files died at import.
 *
 * THE FIX, AND ITS LIMITS. These suites intentionally run on SYNTHETIC, insecure, local-only
 * credentials against a fake in-process provider — so they opt IN explicitly, here, in ONE place,
 * rather than inheriting the flag from an outer script or a developer's shell.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *   - it does NOT weaken production key validation (`src/core/config.ts` is untouched);
 *   - it does NOT change any default;
 *   - it is NEVER imported by product runtime — only by `*.test.ts` under `src/v2/`, which
 *     `cutover-guards.test.ts` enforces as a static guard;
 *   - it uses `??=`, so a real operator value in the environment always wins.
 *
 * USAGE. Import for side effects as the FIRST import of the test file — ESM evaluates imports in
 * source order, so it must precede any import that reaches core config:
 *
 *     import "../test-env.js"; // MUST be first: opts into synthetic dev keys before config loads
 *     import { commands } from "../../cli/registry.js";
 */

// THE SINGLE OWNER moved to `src/test-support/`, because `src/acceptance/` and `src/cli/` need it
// too and v1 must not import v2 to reach a helper. Re-exported here so every v2 suite's import,
// and the guards that pin it, keep working unchanged.
import { HERMETIC_DEV_KEY_ENV, HERMETIC_TEST_KEY_PREFIX } from "../test-support/hermetic-env.js";

process.env.IKBI_ALLOW_INSECURE_DEV_KEYS ??= "true";

export { HERMETIC_DEV_KEY_ENV, HERMETIC_TEST_KEY_PREFIX };

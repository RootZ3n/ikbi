/**
 * ikbi check-triage — the deterministic parser.
 *
 * Pure: no spawn, no model, no IO, no clock/randomness. ANSI-stripped, bounded, head+tail
 * preserving, and total: any internal error falls back to a safe generic summary (never throws).
 */

import { checkTriageConfig, type CheckTriageConfig } from "./config.js";
import type { CheckInput, CheckTriage } from "./contract.js";

/**
 * Strip ANSI escape sequences (CSI / OSC / single-char) and normalize CR → LF. ESC = U+001B.
 *
 * Every sequence below is ANCHORED to ESC (\x1b), so ordinary text is never touched — a bare
 * `FAILED` marker and identifiers with underscores (e.g. `test_foo`) survive intact; only real
 * escape sequences are removed. The anchors are written as explicit \x1b escapes (not invisible
 * literal ESC bytes) so the anchoring is legible in source and an edit cannot silently drop it,
 * which would otherwise turn the single-char rule into a global [@-Z\\-_] strip that mangles
 * uppercase markers like FAILED.
 */
export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ... terminated by BEL or ST
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI ... final byte
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, "") // other single-char ESC sequences
    .replace(/\r\n?/g, "\n"); // CRLF and lone CR → LF (spinner overwrites)
}

function lastNonEmptyLine(s: string): string {
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i]!.trim();
    if (t.length > 0) return t;
  }
  return "";
}

function frameworkHintsFromCommand(cmdLower: string, add: (f: string) => void): void {
  if (/\btsc\b/.test(cmdLower)) add("tsc");
  if (/\bvitest\b|\bjest\b/.test(cmdLower)) add("vitest/jest");
  if (/\bpytest\b/.test(cmdLower)) add("pytest");
  if (/\bgo\b[^\n]*\btest\b/.test(cmdLower)) add("go-test");
  if (/(^|\s)node\b[^\n]*--test\b/.test(cmdLower) || /(^|\s)--test\b/.test(cmdLower)) add("node:test");
}

/** The test frameworks (a tsc typecheck legitimately runs zero "tests" and is NOT subject to the
 *  zero-test floor — only checks that are supposed to RUN tests are). */
const TEST_FRAMEWORKS: readonly string[] = ["vitest/jest", "pytest", "go-test", "node:test"];

/**
 * Is this check supposed to RUN tests? (name like "test"/"e2e"/"integration", a test-runner in the
 * command, or a detected test framework). A `tsc`/typecheck/build/lint check is NOT — it never runs
 * tests, so "zero tests" is not a false-green for it.
 */
function isTestCheck(name: string, cmdLower: string, detectedFrameworks: readonly string[]): boolean {
  if (/\b(test|tests|e2e|integration|spec|specs)\b/i.test(name)) return true;
  if (detectedFrameworks.some((f) => TEST_FRAMEWORKS.includes(f))) return true;
  if (/\b(vitest|jest|pytest|mocha|ava)\b/.test(cmdLower)) return true;
  if (/\bgo\b[^\n]*\btest\b/.test(cmdLower)) return true;
  if (/--test\b/.test(cmdLower)) return true;
  return false;
}

/**
 * VECTOR A detector: did a test runner execute ZERO tests? Exit 0 with no tests (a fresh package
 * with `go test ./...`, `node --test`, `jest --passWithNoTests`, or a no-collect pytest) is a FALSE
 * GREEN — it proves nothing. Per-framework zero-test markers:
 *   - go test        `?   pkg   [no test files]`
 *   - vitest         `No test files found`
 *   - node:test TAP  `# tests 0`
 *   - jest summary   `Tests:       0 total`
 *   - pytest         `collected 0 items` / `no tests ran`
 */
function ranZeroTests(combined: string): boolean {
  for (const raw of combined.split("\n")) {
    const t = raw.trim();
    if (t.length === 0) continue;
    if (/\[no test files\]/i.test(t)) return true;
    if (/no test files found/i.test(t)) return true;
    if (/^#?\s*tests\s+0\b/.test(t)) return true; // node:test TAP: `# tests 0`
    if (/^Tests:\s+0\s+total\b/.test(t)) return true; // jest: `Tests: 0 total`
    if (/\bcollected 0 items\b/i.test(t)) return true; // pytest: `collected 0 items`
    if (/\bno tests ran\b/i.test(t)) return true; // pytest: `no tests ran`
  }
  return false;
}

/** Internal worker — wrapped by parseCheckOutput so the public API never throws. */
function parse(input: CheckInput, cfg: CheckTriageConfig): CheckTriage {
  const exitCode = typeof input.exitCode === "number" && Number.isFinite(input.exitCode) ? input.exitCode : 1;

  const stdout = stripAnsi(typeof input.stdout === "string" ? input.stdout : "");
  const stderr = stripAnsi(typeof input.stderr === "string" ? input.stderr : "");
  const combined = stderr.length > 0 ? `${stdout}${stdout.length > 0 ? "\n" : ""}${stderr}` : stdout;

  // bounded head + tail (preserve BOTH ends; never tail-only)
  let head: string;
  let tail: string;
  let truncated: boolean;
  if (combined.length <= cfg.maxHeadBytes + cfg.maxTailBytes) {
    head = combined;
    tail = "";
    truncated = false;
  } else {
    head = combined.slice(0, cfg.maxHeadBytes);
    tail = combined.slice(combined.length - cfg.maxTailBytes);
    truncated = true;
  }

  const frameworks = new Set<string>();
  const addFw = (f: string): void => void frameworks.add(f);
  frameworkHintsFromCommand((input.command ?? "").toLowerCase(), addFw);

  const failures: string[] = [];
  const seen = new Set<string>();
  const pushFail = (raw: string): void => {
    const t = raw.trim().slice(0, cfg.maxFailureLen);
    if (t.length === 0 || seen.has(t)) return;
    seen.add(t);
    if (failures.length < cfg.maxFailures) failures.push(t);
  };

  for (const line of combined.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;

    // TypeScript tsc: `path(line,col): error TSxxxx: message`
    if (/\(\d+,\d+\):\s*error\s+TS\d+:/.test(t)) {
      addFw("tsc");
      pushFail(t);
      continue;
    }
    // node:test (TAP): `not ok N - name`
    const tap = /^not ok \d+\s*-?\s*(.*)$/.exec(t);
    if (tap) {
      addFw("node:test");
      pushFail((tap[1] ?? "").replace(/\s+#.*$/, "")); // drop a trailing TAP directive
      continue;
    }
    if (/^TAP version \d+/.test(t) || /^# Subtest:/.test(t) || /^ok \d+\s/.test(t)) addFw("node:test");
    // pytest: `FAILED path::test ...` or `path::test FAILED`
    const pyt = /^FAILED\s+(\S+::\S+)/.exec(t) ?? /^(\S+::\S+)\s+FAILED\b/.exec(t);
    if (pyt) {
      addFw("pytest");
      pushFail(pyt[1] ?? "");
      continue;
    }
    if (/^=+\s*(FAILURES|ERRORS|short test summary)/.test(t)) addFw("pytest");
    // go test: `--- FAIL: TestName (0.00s)`
    const go = /^---\s*FAIL:\s+(\S+)/.exec(t);
    if (go) {
      addFw("go-test");
      pushFail(go[1] ?? "");
      continue;
    }
    if (/^=== RUN\s/.test(t) || /^(ok|FAIL)\s+\S+\s+[\d.]+s\b/.test(t)) {
      addFw("go-test");
      continue; // a go summary line — framework hint, not a failure
    }
    // vitest / jest: failure markers `✗ ✕ × `, `FAIL <desc>`, `● <suite › test>`
    const vj = /^(?:[✗✕×]️?|FAIL|●)\s+(.+)$/.exec(t);
    if (vj && vj[1] && !/^FAILED\b/.test(t)) {
      addFw("vitest/jest");
      pushFail(vj[1]);
      continue;
    }
    // framework hints without a captured failure
    if (/^RUN\s+v\d/.test(t) || /^Test Files\b/.test(t) || /^⎯+/.test(t)) addFw("vitest/jest");
    if (/^Tests:\s/.test(t) || /^PASS\s/.test(t)) addFw("vitest/jest");
  }

  const detectedFrameworks = [...frameworks].sort();

  // ── PASS/FAIL: the exit code is a FLOOR, not a ceiling. ───────────────────────────────────
  // VECTOR B (exit-swallowing): `vitest run; echo done` / `jest || true` exit 0 but the real
  //   failure lines are still in the output and parsed into failures[] — fail closed.
  // VECTOR A (zero tests): a test-named check that exit-0'd having run ZERO tests is a false green.
  // exit 0 is necessary but NOT sufficient — both vectors override it to fail.
  const cmdLower = (input.command ?? "").toLowerCase();
  const zeroTests = isTestCheck(input.name, cmdLower, detectedFrameworks) && ranZeroTests(combined);
  const passed = exitCode === 0 && failures.length === 0 && !zeroTests;

  // errorSummary — always non-empty, bounded
  let errorSummary: string;
  if (passed) {
    errorSummary = `${input.name}: passed (exit 0)`;
  } else if (zeroTests) {
    const fw = detectedFrameworks.length > 0 ? detectedFrameworks.join("/") : "unknown format";
    errorSummary = `${input.name}: FAILED — a test check ran ZERO tests (exit ${exitCode}, ${fw}); exit 0 with no tests executed is not a pass`;
  } else if (exitCode === 0 && failures.length > 0) {
    const fw = detectedFrameworks.length > 0 ? detectedFrameworks.join("/") : "unknown format";
    const shown = failures.slice(0, 3).join("; ");
    errorSummary = `${input.name}: FAILED — exit 0 but ${failures.length} failure(s) parsed (exit-swallowing script; exit code is a floor, not a ceiling, ${fw}): ${shown}${failures.length > 3 ? ", …" : ""}`;
  } else {
    const fw = detectedFrameworks.length > 0 ? detectedFrameworks.join("/") : "unknown format";
    if (failures.length > 0) {
      const shown = failures.slice(0, 3).join("; ");
      errorSummary = `${input.name}: FAILED (exit ${exitCode}, ${fw}) — ${failures.length} failure(s): ${shown}${failures.length > 3 ? ", …" : ""}`;
    } else {
      const hint = lastNonEmptyLine(combined);
      errorSummary = `${input.name}: FAILED (exit ${exitCode}, ${fw}) — no structured failures parsed${hint.length > 0 ? `; last line: ${hint.slice(0, cfg.maxFailureLen)}` : ""}`;
    }
  }

  return { passed, failures, errorSummary, head, tail, truncated, detectedFrameworks };
}

export interface CheckTriageApi {
  parseCheckOutput(input: CheckInput): CheckTriage;
}

export function createCheckTriage(cfg: CheckTriageConfig = checkTriageConfig): CheckTriageApi {
  return {
    parseCheckOutput(input: CheckInput): CheckTriage {
      try {
        return parse(input, cfg);
      } catch (err) {
        // NEVER throw: degrade to a safe generic summary. FAIL CLOSED (L9) — a parser crash means
        // we could not verify the output, so we must NOT report a pass on the bare exit code (an
        // exit-swallowed or zero-tests false green would slip through). Unverifiable ⇒ not passed.
        return {
          passed: false,
          failures: [],
          errorSummary: `${input?.name ?? "check"}: triage parser error — failing closed (could not verify): ${err instanceof Error ? err.message : String(err)}`,
          head: "",
          tail: "",
          truncated: false,
          detectedFrameworks: [],
        };
      }
    },
  };
}

const live = createCheckTriage();

/** Parse one check's raw output into structured triage. Deterministic; never throws. */
export function parseCheckOutput(input: CheckInput): CheckTriage {
  return live.parseCheckOutput(input);
}

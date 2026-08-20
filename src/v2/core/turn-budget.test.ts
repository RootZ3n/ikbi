/*
  THE BUILDER TURN BUDGET — the one bound an operator may raise.

  This suite exists because of a real production failure. ikbi's first delegated task on
  another repository ended at `build.turn_limit_exceeded` with two mutations already
  applied and legitimate progress in the log. Governance was right — it failed truthfully,
  promoted nothing, declined to retry — but the twelve-turn bound was scaffold-era and
  there was no way for an operator to authorize more before starting.

  So the claims here are about a knob, and about everything the knob must NOT touch:

    · unset is twelve, and twelve is not a problem
    · a lawful override is used exactly as given
    · a malformed, zero, negative or over-ceiling value is REFUSED, never partly parsed
      and never silently clamped
    · raising turns raises NOTHING else — not tools, not mutations, not commands, not
      output tokens, not money
    · the environment cannot change a session's authority after it has begun
*/

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BUILDER_TURNS_ENV,
  DEFAULT_BUILDER_BUDGET,
  MAX_BUILDER_COMMANDS_CEILING,
  MAX_BUILDER_TOOL_CALLS_CEILING,
  MAX_BUILDER_TURNS_CEILING,
  builderBudgetWith,
  builderBudgetWithTurns,
  resolveBuilderCommands,
  resolveBuilderToolCalls,
  resolveBuilderTurns,
} from "./builder.js";
import { summarizeBuilderBudget } from "./result.js";

/* ── A. unset ─────────────────────────────────────────────────────────────── */

test("turn budget: unset is the shipped default of 12", () => {
  const r = resolveBuilderTurns(undefined);
  assert.ok(r.ok);
  assert.equal(r.maxTurns, 12);
  assert.equal(r.maxTurns, DEFAULT_BUILDER_BUDGET.maxTurns, "the default is read from the budget, not remembered");
  assert.equal(r.source, "default");
});

test("turn budget: blank and whitespace are also the default, not an error", () => {
  // An exported-but-empty variable is how a shell says "not set", and treating it as a
  // typo would make `export IKBI_V2_MAX_BUILDER_TURNS=` fatal for no reason.
  for (const raw of ["", "   ", "\t", "\n"]) {
    const r = resolveBuilderTurns(raw);
    assert.ok(r.ok, `${JSON.stringify(raw)} should be the default`);
    assert.equal(r.maxTurns, 12);
    assert.equal(r.source, "default");
  }
});

/* ── B. a lawful override ─────────────────────────────────────────────────── */

test("turn budget: a valid override is used exactly as given", () => {
  const r = resolveBuilderTurns("30");
  assert.ok(r.ok);
  assert.equal(r.maxTurns, 30);
  assert.equal(r.source, "operator_env", "and the receipt can say the operator set it");
});

test("turn budget: surrounding whitespace is tolerated, inner text is not", () => {
  const padded = resolveBuilderTurns("  24  ");
  assert.ok(padded.ok);
  assert.equal(padded.maxTurns, 24);

  const inner = resolveBuilderTurns("2 4");
  assert.equal(inner.ok, false, "a space inside the number is not a number");
});

test("turn budget: the boundary values are lawful", () => {
  const one = resolveBuilderTurns("1");
  assert.ok(one.ok);
  assert.equal(one.maxTurns, 1, "one turn is a legitimate, if useless, budget");

  const ceiling = resolveBuilderTurns(String(MAX_BUILDER_TURNS_CEILING));
  assert.ok(ceiling.ok);
  assert.equal(ceiling.maxTurns, MAX_BUILDER_TURNS_CEILING, "the ceiling itself is allowed");
});

/* ── C. malformed ─────────────────────────────────────────────────────────── */

test("turn budget: a malformed value is REFUSED, never partly parsed", () => {
  /*
    The specific danger each of these carries if it were parsed loosely: `30junk` and
    `12abc` become 30 and 12 under parseInt; `2.5` becomes 2; `1e3` becomes 1 (or 1000);
    `0x10` becomes 0 or 16. Every one would hand the operator a number they did not type.
  */
  for (const raw of ["30junk", "12abc", "2.5", "1e3", "0x10", "twelve", "12,5", "+", "--5", "1_000"]) {
    const r = resolveBuilderTurns(raw);
    assert.equal(r.ok, false, `${raw} must be refused`);
    if (!r.ok) {
      assert.match(r.reason, new RegExp(BUILDER_TURNS_ENV), `${raw}: the reason names the variable`);
      assert.doesNotMatch(r.reason, /^\s*$/, `${raw}: the reason is not empty`);
    }
  }
});

test("turn budget: refusing says the lawful range, so the fix is obvious", () => {
  const r = resolveBuilderTurns("30junk");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /1–100|1-100/, r.reason);
    assert.match(r.reason, /30junk/, "and quotes what was actually set");
  }
});

/* ── D. zero and negative ─────────────────────────────────────────────────── */

test("turn budget: zero and negative are refused", () => {
  for (const raw of ["0", "-1", "-30", "-0"]) {
    const r = resolveBuilderTurns(raw);
    assert.equal(r.ok, false, `${raw} must be refused`);
  }
  const zero = resolveBuilderTurns("0");
  assert.equal(zero.ok, false);
  if (!zero.ok) assert.match(zero.reason, /no builder turns/, zero.reason);
});

/* ── E. the hard ceiling ──────────────────────────────────────────────────── */

test("turn budget: above the ceiling is REFUSED, not clamped", () => {
  const r = resolveBuilderTurns("1000");
  assert.equal(r.ok, false, "a value over the ceiling must not silently become the ceiling");
  if (!r.ok) {
    assert.match(r.reason, /ceiling/i);
    assert.match(r.reason, /1000/, "it quotes the value that was refused");
    assert.match(r.reason, new RegExp(String(MAX_BUILDER_TURNS_CEILING)), "and states the ceiling");
  }
  assert.equal(resolveBuilderTurns(String(MAX_BUILDER_TURNS_CEILING + 1)).ok, false, "one over is over");
});

test("turn budget: the ceiling is a safety boundary, and a stated one", () => {
  assert.equal(MAX_BUILDER_TURNS_CEILING, 100);
  assert.ok(MAX_BUILDER_TURNS_CEILING > DEFAULT_BUILDER_BUDGET.maxTurns, "a ceiling below the default would be absurd");
});

/* ── I. raising turns raises nothing else ─────────────────────────────────── */

test("turn budget: raising turns leaves every other bound exactly where it was", () => {
  const raised = builderBudgetWithTurns(40);
  assert.equal(raised.maxTurns, 40);
  // The whole point. A longer builder is still bounded by all of these.
  assert.equal(raised.maxToolCalls, DEFAULT_BUILDER_BUDGET.maxToolCalls);
  assert.equal(raised.maxMutations, DEFAULT_BUILDER_BUDGET.maxMutations);
  assert.equal(raised.maxCommands, DEFAULT_BUILDER_BUDGET.maxCommands);
  assert.equal(raised.maxOutputTokens, DEFAULT_BUILDER_BUDGET.maxOutputTokens);
  assert.equal(raised.turnTimeoutMs, DEFAULT_BUILDER_BUDGET.turnTimeoutMs);

  // And every key is accounted for — a bound added later must be considered here rather
  // than silently inheriting whatever this function happened to copy.
  assert.deepEqual(
    Object.keys(raised).sort(),
    Object.keys(DEFAULT_BUILDER_BUDGET).sort(),
    "the raised budget has exactly the shipped budget's shape",
  );
});

test("turn budget: the shipped default is not mutated by raising one", () => {
  const before = DEFAULT_BUILDER_BUDGET.maxTurns;
  builderBudgetWithTurns(99);
  assert.equal(DEFAULT_BUILDER_BUDGET.maxTurns, before, "the frozen default is the default forever");
  assert.ok(Object.isFrozen(DEFAULT_BUILDER_BUDGET));
  assert.ok(Object.isFrozen(builderBudgetWithTurns(20)), "and a derived budget is frozen too");
});

test("turn budget: the turn budget grants no money and no extra model calls", () => {
  /*
    Stated as a claim about shape rather than behaviour: there is no field on a builder
    budget that could authorize spend or invocations. The session cost ceiling and the
    invocation cap live on the cost policy, which this function cannot reach.
  */
  const raised = builderBudgetWithTurns(100);
  const keys = Object.keys(raised);
  assert.ok(!keys.some((k) => /cost|usd|price|invocation|spend|budgetUsd/i.test(k)), keys.join(", "));
});

/* ── J. receipt truth ─────────────────────────────────────────────────────── */

test("turn budget: the receipt states the effective budget and where it came from", () => {
  const raised = summarizeBuilderBudget(builderBudgetWithTurns(24), "operator_env", "default", "default");
  assert.equal(raised.maxTurns, 24);
  assert.equal(raised.turnSource, "operator_env");
  // It also records what did NOT move, so a reader can see the raise was narrow.
  assert.equal(raised.maxToolCalls, DEFAULT_BUILDER_BUDGET.maxToolCalls);
  assert.equal(raised.maxMutations, DEFAULT_BUILDER_BUDGET.maxMutations);
  assert.equal(raised.maxCommands, DEFAULT_BUILDER_BUDGET.maxCommands);

  const shipped = summarizeBuilderBudget(DEFAULT_BUILDER_BUDGET, "default", "default", "default");
  assert.equal(shipped.maxTurns, 12);
  assert.equal(shipped.turnSource, "default");
});

test("turn budget: the summary carries no credential and no free text", () => {
  const s = summarizeBuilderBudget(builderBudgetWithTurns(30), "operator_env", "default", "default");
  for (const [k, v] of Object.entries(s)) {
    assert.ok(typeof v === "number" || typeof v === "string", k);
    if (typeof v === "string") assert.match(v, /^(default|operator_env)$/, `${k}=${v}`);
  }
});

/* ── F. the freeze, structurally ──────────────────────────────────────────── */

test("turn budget (F): the environment is read at exactly ONE place in the run path", () => {
  /*
    The behavioural half of this claim is in `builder.test.ts` — the loop is handed a
    number and never consults the environment. This is the other half: there is only one
    place the number can come from, and it is the per-session wiring seam.

    A second reader anywhere in the run path would be a way for a session to gain builder
    authority after it began, which is the one thing this knob must not permit.
  */
  const runtime = readFileSync(new URL("../../../src/v2/runtime/index.ts", import.meta.url), "utf8");
  const reads = runtime.match(/process\.env\[BUILDER_TURNS_ENV\]|process\.env\.IKBI_V2_MAX_BUILDER_TURNS/g) ?? [];
  assert.equal(reads.length, 1, `the runtime reads the turn budget ${reads.length} times; it must be once`);

  // And that one read is inside the resolver that `wireRunDeps` calls once per session.
  /* Renamed to `envBuilderBudget` when the tool-call knob joined it — one resolver now
     reads both bounds, still exactly once, still inside the per-session wiring seam. */
  assert.match(runtime, /function envBuilderBudget\([\s\S]{0,600}?process\.env\[BUILDER_TURNS_ENV\]/);
  assert.match(runtime, /function envBuilderBudget\([\s\S]{0,600}?process\.env\[BUILDER_TOOL_CALLS_ENV\]/);

  // The pure core never reads an environment at all — it is handed a budget.
  const builder = readFileSync(new URL("../../../src/v2/core/builder.ts", import.meta.url), "utf8");
  assert.doesNotMatch(builder, /process\.env/, "the builder core must take its bounds as an argument");
});

test("turn budget (F): resolution is pure, so the same input always gives the same budget", () => {
  // No hidden state: calling it twice with the same string cannot drift.
  assert.deepEqual(resolveBuilderTurns("24"), resolveBuilderTurns("24"));
  assert.deepEqual(resolveBuilderTurns("nope"), resolveBuilderTurns("nope"));
});


/* ── THE TOOL-CALL BUDGET ────────────────────────────────────────────────────

   Added only after three materially different models were measured on the same real
   task. MiMo burned forty calls looping and wrote nothing — a model problem. But
   MiniMax spent its forty across seven substantial write turns with zero redundant
   commands, and GLM-5.2 was on the same trajectory with six. Two independent vendors
   doing genuine work hit the identical wall, which is what separates "the limit is too
   low" from "that model is wasteful". */

test("tool budget (A): unset is the shipped default of 40", () => {
  const r = resolveBuilderToolCalls(undefined);
  assert.ok(r.ok);
  assert.equal(r.value, 40);
  assert.equal(r.value, DEFAULT_BUILDER_BUDGET.maxToolCalls, "read from the budget, not remembered");
  assert.equal(r.source, "default");
});

test("tool budget (B/C): a lawful override is used exactly as given", () => {
  const raised = resolveBuilderToolCalls("150");
  assert.ok(raised.ok);
  assert.equal(raised.value, 150);
  assert.equal(raised.source, "operator_env");

  const lowered = resolveBuilderToolCalls("5");
  assert.ok(lowered.ok);
  assert.equal(lowered.value, 5, "an operator may also tighten it");
});

test("tool budget (D): malformed values are REFUSED, never partly parsed", () => {
  /* Each would become a number nobody typed under loose parsing: 150junk→150, 2.5→2,
     0x20→0 or 32, 1e3→1. */
  for (const raw of ["150junk", "2.5", "0x20", "1e3", "forty", "1,50", "+", "--5"]) {
    const r = resolveBuilderToolCalls(raw);
    assert.equal(r.ok, false, `${raw} must be refused`);
    if (!r.ok) assert.match(r.reason, /IKBI_V2_MAX_TOOL_CALLS/);
  }
  // Blank is the DEFAULT, not an error — `export VAR=` is how a shell says "unset".
  for (const blank of ["", "   ", "\t"]) {
    const r = resolveBuilderToolCalls(blank);
    assert.ok(r.ok, JSON.stringify(blank));
    assert.equal(r.source, "default");
  }
});

test("tool budget (E/F): zero and negative are refused", () => {
  for (const raw of ["0", "-1", "-150"]) assert.equal(resolveBuilderToolCalls(raw).ok, false, raw);
  const zero = resolveBuilderToolCalls("0");
  if (!zero.ok) assert.match(zero.reason, /no tool calls/);
});

test("tool budget (G/H): the ceiling is refused above and accepted at", () => {
  const over = resolveBuilderToolCalls(String(MAX_BUILDER_TOOL_CALLS_CEILING + 1));
  assert.equal(over.ok, false, "one over is over");
  if (!over.ok) assert.match(over.reason, /ceiling/i);
  assert.equal(resolveBuilderToolCalls("5000").ok, false, "and a typo cannot authorize thousands");

  const at = resolveBuilderToolCalls(String(MAX_BUILDER_TOOL_CALLS_CEILING));
  assert.ok(at.ok, "the ceiling itself is allowed");
  assert.equal(at.value, 500);
});

test("tool budget: the ceiling leaves real room above known-good practice", () => {
  assert.equal(MAX_BUILDER_TOOL_CALLS_CEILING, 500);
  assert.ok(MAX_BUILDER_TOOL_CALLS_CEILING > 150, "150 is a real operator setting elsewhere and must fit comfortably");
  assert.ok(MAX_BUILDER_TOOL_CALLS_CEILING > DEFAULT_BUILDER_BUDGET.maxToolCalls);
});

test("tool budget: raising tool calls raises NOTHING else", () => {
  const raised = builderBudgetWith({ maxToolCalls: 150 });
  assert.equal(raised.maxToolCalls, 150);
  assert.equal(raised.maxTurns, DEFAULT_BUILDER_BUDGET.maxTurns);
  assert.equal(raised.maxMutations, DEFAULT_BUILDER_BUDGET.maxMutations);
  assert.equal(raised.maxCommands, DEFAULT_BUILDER_BUDGET.maxCommands);
  assert.equal(raised.maxOutputTokens, DEFAULT_BUILDER_BUDGET.maxOutputTokens);
  assert.equal(raised.turnTimeoutMs, DEFAULT_BUILDER_BUDGET.turnTimeoutMs);
  // A bound added later must be considered here rather than silently inherited.
  assert.deepEqual(Object.keys(raised).sort(), Object.keys(DEFAULT_BUILDER_BUDGET).sort());
  assert.ok(Object.isFrozen(raised));
});

test("tool budget: both knobs can be raised together, and only those two move", () => {
  const both = builderBudgetWith({ maxTurns: 32, maxToolCalls: 150 });
  assert.equal(both.maxTurns, 32);
  assert.equal(both.maxToolCalls, 150);
  assert.equal(both.maxMutations, DEFAULT_BUILDER_BUDGET.maxMutations);
  assert.equal(both.maxCommands, DEFAULT_BUILDER_BUDGET.maxCommands);
  // The shipped default is never mutated by deriving from it.
  assert.equal(DEFAULT_BUILDER_BUDGET.maxToolCalls, 40);
  assert.equal(DEFAULT_BUILDER_BUDGET.maxTurns, 12);
});

test("tool budget: it grants no money and no extra model calls", () => {
  const keys = Object.keys(builderBudgetWith({ maxToolCalls: 500 }));
  assert.ok(!keys.some((k) => /cost|usd|price|invocation|spend/i.test(k)), keys.join(", "));
});

test("tool budget: the two knobs share ONE parser, so they cannot drift", () => {
  /*
    Same malformed input, same verdict, differing only in which variable is named. Two
    copies of this logic would eventually disagree about what "2.5" means, and the one
    that drifted would be the one nobody was testing.
  */
  for (const raw of ["2.5", "0", "-1", "junk"]) {
    assert.equal(resolveBuilderTurns(raw).ok, resolveBuilderToolCalls(raw).ok, raw);
  }
  const turns = resolveBuilderTurns("2.5");
  const tools = resolveBuilderToolCalls("2.5");
  assert.equal(turns.ok, false);
  assert.equal(tools.ok, false);
  if (!turns.ok && !tools.ok) {
    assert.match(turns.reason, /IKBI_V2_MAX_BUILDER_TURNS/);
    assert.match(tools.reason, /IKBI_V2_MAX_TOOL_CALLS/);
  }
});

test("tool budget: the receipt says the effective value AND where it came from", () => {
  const raised = summarizeBuilderBudget(builderBudgetWith({ maxToolCalls: 150 }), "default", "operator_env", "default");
  assert.equal(raised.maxToolCalls, 150);
  assert.equal(raised.toolCallSource, "operator_env");
  assert.equal(raised.turnSource, "default", "and the two sources are independent");
  // It still records what did NOT move.
  assert.equal(raised.maxMutations, DEFAULT_BUILDER_BUDGET.maxMutations);
  assert.equal(raised.maxCommands, DEFAULT_BUILDER_BUDGET.maxCommands);

  const shipped = summarizeBuilderBudget(DEFAULT_BUILDER_BUDGET, "default", "default", "default");
  assert.equal(shipped.maxToolCalls, 40);
  assert.equal(shipped.toolCallSource, "default");
});

test("tool budget: resolution is pure, and the runtime reads the env exactly ONCE", () => {
  assert.deepEqual(resolveBuilderToolCalls("150"), resolveBuilderToolCalls("150"));

  const runtime = readFileSync(new URL("../../../src/v2/runtime/index.ts", import.meta.url), "utf8");
  const reads = runtime.match(/process\.env\[BUILDER_TOOL_CALLS_ENV\]|process\.env\.IKBI_V2_MAX_TOOL_CALLS/g) ?? [];
  assert.equal(reads.length, 1, `the runtime reads it ${reads.length} times; it must be once`);

  // The pure core never reads an environment at all — it is handed a budget.
  const builder = readFileSync(new URL("../../../src/v2/core/builder.ts", import.meta.url), "utf8");
  assert.doesNotMatch(builder, /process\.env/, "the builder core takes its bounds as an argument");
});


/* ── THE COMMAND BUDGET ──────────────────────────────────────────────────────

   The third bound, added for the same reason as the other two: it was measured as the
   binding constraint on real work. With tool calls raised to 150, three independent
   models would each have hit the command wall at roughly call 51 — every one of them had
   already spent 19 of 24 commands inside its first forty calls, and MiniMax, the
   productive one, was at ordinal 21 of 24 when its tool calls ran out. */

test("command budget: unset is the shipped default of 24", () => {
  const r = resolveBuilderCommands(undefined);
  assert.ok(r.ok);
  assert.equal(r.value, 24);
  assert.equal(r.value, DEFAULT_BUILDER_BUDGET.maxCommands, "read from the budget, not remembered");
  assert.equal(r.source, "default");
});

test("command budget: lawful values are used verbatim, including the boundaries", () => {
  for (const [raw, want] of [["100", 100], ["1", 1], [String(MAX_BUILDER_COMMANDS_CEILING), MAX_BUILDER_COMMANDS_CEILING]] as const) {
    const r = resolveBuilderCommands(raw);
    assert.ok(r.ok, raw);
    assert.equal(r.value, want);
    assert.equal(r.source, "operator_env");
  }
});

test("command budget: malformed, zero, negative and over-ceiling are refused", () => {
  for (const raw of ["100junk", "2.5", "0x20", "1e3", "0", "-1", String(MAX_BUILDER_COMMANDS_CEILING + 1), "9999"]) {
    const r = resolveBuilderCommands(raw);
    assert.equal(r.ok, false, `${raw} must be refused`);
    if (!r.ok) assert.match(r.reason, /IKBI_V2_MAX_COMMANDS/);
  }
  // Blank is the DEFAULT, not an error.
  for (const blank of ["", "  "]) {
    const r = resolveBuilderCommands(blank);
    assert.ok(r.ok);
    assert.equal(r.source, "default");
  }
});

test("command budget: the ceiling leaves headroom above the observed command ratio", () => {
  assert.equal(MAX_BUILDER_COMMANDS_CEILING, 250);
  // Production measured ~0.47 commands per tool call; 150 tool calls implies ~71.
  assert.ok(MAX_BUILDER_COMMANDS_CEILING > Math.ceil(150 * 0.47) * 2, "real headroom over the measured ratio");
  assert.ok(MAX_BUILDER_COMMANDS_CEILING > DEFAULT_BUILDER_BUDGET.maxCommands);
});

/* ── ONE resolver, three bounds ──────────────────────────────────────────── */

test("bounds: turns, tool calls and commands share ONE parser", () => {
  /*
    The same malformed input gets the same verdict from all three; the ONLY difference is
    which variable the refusal names. Three copies of this logic would eventually
    disagree, and the copy that drifted would be the one nobody was testing.
  */
  for (const raw of ["2.5", "0", "-1", "junk", "0x20", ""]) {
    const t = resolveBuilderTurns(raw);
    const c = resolveBuilderToolCalls(raw);
    const m = resolveBuilderCommands(raw);
    assert.equal(t.ok, c.ok, `turns vs tools disagree on ${JSON.stringify(raw)}`);
    assert.equal(c.ok, m.ok, `tools vs commands disagree on ${JSON.stringify(raw)}`);
  }
  const [t, c, m] = [resolveBuilderTurns("2.5"), resolveBuilderToolCalls("2.5"), resolveBuilderCommands("2.5")];
  assert.ok(!t.ok && !c.ok && !m.ok);
  if (!t.ok && !c.ok && !m.ok) {
    assert.match(t.reason, /IKBI_V2_MAX_BUILDER_TURNS/);
    assert.match(c.reason, /IKBI_V2_MAX_TOOL_CALLS/);
    assert.match(m.reason, /IKBI_V2_MAX_COMMANDS/);
    // Same shape of complaint, different subject.
    assert.match(m.reason, /is not an integer/);
  }
});

test("bounds: raising commands raises NOTHING else", () => {
  const raised = builderBudgetWith({ maxCommands: 100 });
  assert.equal(raised.maxCommands, 100);
  assert.equal(raised.maxTurns, DEFAULT_BUILDER_BUDGET.maxTurns);
  assert.equal(raised.maxToolCalls, DEFAULT_BUILDER_BUDGET.maxToolCalls);
  assert.equal(raised.maxMutations, DEFAULT_BUILDER_BUDGET.maxMutations);
  assert.equal(raised.maxOutputTokens, DEFAULT_BUILDER_BUDGET.maxOutputTokens);
  assert.equal(raised.turnTimeoutMs, DEFAULT_BUILDER_BUDGET.turnTimeoutMs);
  assert.deepEqual(Object.keys(raised).sort(), Object.keys(DEFAULT_BUILDER_BUDGET).sort());
});

test("bounds: the full qualification envelope moves exactly three numbers", () => {
  const envelope = builderBudgetWith({ maxTurns: 32, maxToolCalls: 150, maxCommands: 100 });
  assert.equal(envelope.maxTurns, 32);
  assert.equal(envelope.maxToolCalls, 150);
  assert.equal(envelope.maxCommands, 100);
  assert.equal(envelope.maxMutations, 20, "mutations stay shipped");
  assert.equal(envelope.maxOutputTokens, DEFAULT_BUILDER_BUDGET.maxOutputTokens);
  // And the shipped defaults are untouched by deriving from them.
  assert.equal(DEFAULT_BUILDER_BUDGET.maxTurns, 12);
  assert.equal(DEFAULT_BUILDER_BUDGET.maxToolCalls, 40);
  assert.equal(DEFAULT_BUILDER_BUDGET.maxCommands, 24);
});

test("bounds: the receipt records all three sources independently", () => {
  const s = summarizeBuilderBudget(builderBudgetWith({ maxTurns: 32, maxToolCalls: 150, maxCommands: 100 }), "operator_env", "operator_env", "operator_env");
  assert.equal(s.maxTurns, 32);
  assert.equal(s.maxToolCalls, 150);
  assert.equal(s.maxCommands, 100);
  assert.equal(s.commandSource, "operator_env");

  const mixed = summarizeBuilderBudget(builderBudgetWith({ maxCommands: 100 }), "default", "default", "operator_env");
  assert.equal(mixed.turnSource, "default");
  assert.equal(mixed.toolCallSource, "default");
  assert.equal(mixed.commandSource, "operator_env", "one raised bound does not relabel the others");
});

test("command budget: the runtime reads the env exactly ONCE, and the core reads none", () => {
  const runtime = readFileSync(new URL("../../../src/v2/runtime/index.ts", import.meta.url), "utf8");
  const reads = runtime.match(/process\.env\[BUILDER_COMMANDS_ENV\]|process\.env\.IKBI_V2_MAX_COMMANDS/g) ?? [];
  assert.equal(reads.length, 1, `read ${reads.length} times; must be once`);
  assert.match(runtime, /function envBuilderBudget\([\s\S]{0,900}?process\.env\[BUILDER_COMMANDS_ENV\]/);
  const builder = readFileSync(new URL("../../../src/v2/core/builder.ts", import.meta.url), "utf8");
  assert.doesNotMatch(builder, /process\.env/);
});

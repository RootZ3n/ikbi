import assert from "node:assert/strict";
import { test } from "node:test";

import { TIER_PRESETS, BUILD_TIERS, isBuildTier, resolveTierPreset, type BuildTier } from "./tier-presets.js";
import { parseBuildArgs } from "./cli.js";

// ── The preset table is the documented contract for `--tier` ──────────────────────────────────
// These exact model ids + escalation flags ARE the feature: cheap escalates flash→pro, mid and
// frontier each run one capable builder with escalation OFF. Pin every field so a silent edit to
// the table (a renamed model, a flipped escalation flag) fails loudly.

test("tier presets: cheap = flash builder + pro critic, escalation ON to pro", () => {
  const cheap = TIER_PRESETS.cheap;
  assert.equal(cheap.tier, "cheap");
  assert.equal(cheap.builderModel, "deepseek-v4-flash");
  assert.equal(cheap.criticModel, "deepseek-v4-pro");
  assert.equal(cheap.escalation, true, "cheap tier auto-escalates");
  assert.equal(cheap.fallbackModel, "mimo-v2.5-pro", "cheap escalates to the preferred pro (mid[0], Mimo first)");
});

test("tier presets: mid = glm-5.2 builder + minimax-m3 critic, escalation OFF (no fallback)", () => {
  const mid = TIER_PRESETS.mid;
  assert.equal(mid.builderModel, "glm-5.2");
  assert.equal(mid.criticModel, "minimax-m3");
  assert.equal(mid.escalation, false, "mid tier never silently escalates");
  assert.equal(mid.fallbackModel, undefined, "no escalation target when escalation is off");
});

test("tier presets: frontier = sonnet-4.6 builder + gpt-5.5 critic, escalation OFF (no fallback)", () => {
  const frontier = TIER_PRESETS.frontier;
  assert.equal(frontier.builderModel, "sonnet-4.6");
  assert.equal(frontier.criticModel, "gpt-5.5");
  assert.equal(frontier.escalation, false, "frontier tier never silently escalates");
  assert.equal(frontier.fallbackModel, undefined);
});

test("tier presets: ONLY the cheap tier permits auto-escalation", () => {
  const escalating = BUILD_TIERS.filter((t) => TIER_PRESETS[t].escalation);
  assert.deepEqual(escalating, ["cheap"], "cheap is the only tier with escalation ON");
});

test("isBuildTier accepts the three tiers and rejects anything else", () => {
  for (const t of ["cheap", "mid", "frontier"]) assert.equal(isBuildTier(t), true, `${t} is a tier`);
  for (const bad of ["", "turbo", "Cheap", "premium", "deepseek-v4-flash"]) assert.equal(isBuildTier(bad), false, `${bad} is not a tier`);
});

test("resolveTierPreset returns the preset for a valid tier and undefined otherwise", () => {
  assert.equal(resolveTierPreset("mid"), TIER_PRESETS.mid);
  assert.equal(resolveTierPreset("nope"), undefined);
});

test("BUILD_TIERS lists every preset key, cheapest first", () => {
  assert.deepEqual([...BUILD_TIERS], ["cheap", "mid", "frontier"]);
  assert.deepEqual([...BUILD_TIERS].sort(), Object.keys(TIER_PRESETS).sort(), "BUILD_TIERS and the table agree");
});

// ── parseBuildArgs wires --tier into the build options ────────────────────────────────────────

test("parseBuildArgs: --tier <name> and --tier=<name> both parse", () => {
  for (const t of ["cheap", "mid", "frontier"] as const) {
    assert.equal(parseBuildArgs(["goal", "--tier", t]).tier, t, `--tier ${t}`);
    assert.equal(parseBuildArgs(["goal", `--tier=${t}`]).tier, t, `--tier=${t}`);
  }
});

test("parseBuildArgs: an unknown --tier value drops to undefined (build() rejects it)", () => {
  // parseBuildArgs only RECORDS a recognized tier; the CLI surfaces the error so the goal parse
  // stays pure. An unknown value must NOT silently select a default tier.
  assert.equal(parseBuildArgs(["goal", "--tier", "turbo"]).tier, undefined);
  assert.equal(parseBuildArgs(["goal", "--tier=premium"]).tier, undefined);
});

test("parseBuildArgs: no --tier flag leaves tier undefined and the goal intact", () => {
  const parsed = parseBuildArgs(["build", "the", "thing"]);
  assert.equal(parsed.tier, undefined);
  assert.deepEqual(parsed.rest, ["build", "the", "thing"], "tier parsing does not eat goal words");
});

test("parseBuildArgs: --tier composes with other flags without conflict", () => {
  const parsed = parseBuildArgs(["fix", "it", "--repo", "/r", "--tier", "frontier", "--verbose"]);
  assert.equal(parsed.tier, "frontier");
  assert.equal(parsed.repo, "/r");
  assert.equal(parsed.verbose, true);
  assert.deepEqual(parsed.rest, ["fix", "it"]);
});

// Exhaustiveness guard: if a BuildTier is added without a preset, this fails to compile/run.
test("every BuildTier has a preset entry", () => {
  for (const t of BUILD_TIERS) {
    const preset: BuildTier = TIER_PRESETS[t].tier;
    assert.equal(preset, t, `preset for ${t} self-identifies`);
  }
});

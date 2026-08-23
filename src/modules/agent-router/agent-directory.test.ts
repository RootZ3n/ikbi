/**
 * ikbi agent-directory tests — load JSON + YAML personas, the minimal YAML reader, validation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";

import { agentsDir, findCustomAgent, loadCustomAgents, MAX_AGENT_FILES, parseSimpleYaml, validateAgent } from "./agent-directory.js";

function repoWithAgents(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-agents-"));
  const dir = agentsDir(repo);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return repo;
}

test("parseSimpleYaml: scalars, block scalar, block + inline lists", () => {
  const yaml = [
    "name: reviewer",
    "model_preference: deepseek-v4-pro",
    "allowed_tools:",
    "  - read_file",
    "  - search_files",
    "system_prompt: |",
    "  You are a reviewer.",
    "  Be concise.",
  ].join("\n");
  const obj = parseSimpleYaml(yaml);
  assert.equal(obj.name, "reviewer");
  assert.equal(obj.model_preference, "deepseek-v4-pro");
  assert.deepEqual(obj.allowed_tools, ["read_file", "search_files"]);
  assert.equal(obj.system_prompt, "You are a reviewer.\nBe concise.");
});

test("parseSimpleYaml: inline flow list + quoted scalar + comment", () => {
  const yaml = 'name: "doc writer"  # the persona\nallowed_tools: [read_file, write_file]\nsystem_prompt: "Write docs."';
  const obj = parseSimpleYaml(yaml);
  assert.equal(obj.name, "doc writer");
  assert.deepEqual(obj.allowed_tools, ["read_file", "write_file"]);
  assert.equal(obj.system_prompt, "Write docs.");
});

test("loadCustomAgents: loads YAML and JSON personas", () => {
  const repo = repoWithAgents({
    "reviewer.yaml": "name: reviewer\nsystem_prompt: Review carefully.\nallowed_tools:\n  - read_file\n",
    "writer.json": JSON.stringify({ name: "writer", system_prompt: "Write tests.", model_preference: "mimo-v2.5" }),
  });
  const { agents, errors } = loadCustomAgents(repo);
  assert.equal(errors.length, 0);
  assert.equal(agents.length, 2);
  const reviewer = agents.find((a) => a.name === "reviewer");
  assert.deepEqual([...(reviewer?.allowedTools ?? [])], ["read_file"]);
  const writer = agents.find((a) => a.name === "writer");
  assert.equal(writer?.modelPreference, "mimo-v2.5");
});

test("loadCustomAgents: missing directory yields empty result, no error", () => {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-noagents-"));
  const res = loadCustomAgents(repo);
  assert.deepEqual(res.agents, []);
  assert.deepEqual(res.errors, []);
});

// ── Directory size limit (RC6) ──────────────────────────────────────────────────

test("loadCustomAgents: a directory at the limit loads normally", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 3; i += 1) files[`a${i}.json`] = JSON.stringify({ name: `a${i}`, system_prompt: "p" });
  const repo = repoWithAgents(files);
  const res = loadCustomAgents(repo, 3); // exactly at the limit
  assert.equal(res.errors.length, 0);
  assert.equal(res.agents.length, 3);
});

test("loadCustomAgents: a directory OVER the limit fails clearly and loads nothing", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 4; i += 1) files[`a${i}.json`] = JSON.stringify({ name: `a${i}`, system_prompt: "p" });
  const repo = repoWithAgents(files);
  const res = loadCustomAgents(repo, 3); // 4 files, limit 3
  assert.equal(res.agents.length, 0, "no partial load when over the limit");
  assert.equal(res.errors.length, 1);
  const err = res.errors[0]!;
  assert.match(err.error, /AGENT_DIRECTORY_TOO_LARGE/);
  assert.match(err.error, /limit of 3/);          // includes the limit
  assert.equal(err.file, agentsDir(repo));          // includes the directory
});

test("loadCustomAgents: non-agent files do NOT count toward the limit", () => {
  const files: Record<string, string> = {
    "keep.json": JSON.stringify({ name: "keep", system_prompt: "p" }),
  };
  for (let i = 0; i < 50; i += 1) files[`notes${i}.txt`] = "ignore me"; // not yaml/json
  const repo = repoWithAgents(files);
  const res = loadCustomAgents(repo, 3); // only 1 agent file → under the limit
  assert.equal(res.errors.length, 0);
  assert.equal(res.agents.length, 1);
});

test("MAX_AGENT_FILES default is a sane positive number", () => {
  assert.ok(Number.isInteger(MAX_AGENT_FILES) && MAX_AGENT_FILES > 0);
});

test("loadCustomAgents: a malformed file is reported, the rest still load", () => {
  const repo = repoWithAgents({
    "ok.yaml": "name: ok\nsystem_prompt: fine\n",
    "bad.json": "{ not valid json",
    "nosys.yaml": "name: incomplete\n",
  });
  const { agents, errors } = loadCustomAgents(repo);
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.name, "ok");
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /parse failed/.test(e.error)));
  assert.ok(errors.some((e) => /system_prompt/.test(e.error)));
});

test("loadCustomAgents: duplicate names are rejected (first wins)", () => {
  const repo = repoWithAgents({
    "a.yaml": "name: dup\nsystem_prompt: first\n",
    "b.yaml": "name: dup\nsystem_prompt: second\n",
  });
  const { agents, errors } = loadCustomAgents(repo);
  assert.equal(agents.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.error ?? "", /duplicate/);
});

test("validateAgent: name defaults to the file basename", () => {
  const res = validateAgent({ system_prompt: "x" }, "/repo/.ikbi/agents/scout.yaml");
  assert.ok("agent" in res);
  if ("agent" in res) assert.equal(res.agent.name, "scout");
});

test("findCustomAgent: case-insensitive lookup", () => {
  const repo = repoWithAgents({ "reviewer.yaml": "name: Reviewer\nsystem_prompt: hi\n" });
  assert.equal(findCustomAgent(repo, "reviewer")?.name, "Reviewer");
  assert.equal(findCustomAgent(repo, "nope"), undefined);
});

// ── BUILT-IN AGENTS (Pehlichi ships with ikbi; custom overrides by name) ──────────────────────────

test("getBuiltinAgents ships Pehlichi with a system prompt, read-only tools, and a model", async () => {
  const { getBuiltinAgents } = await import("./agent-directory.js");
  const peh = getBuiltinAgents().find((a) => a.name.toLowerCase() === "pehlichi");
  assert.ok(peh, "Pehlichi is a built-in");
  assert.ok(peh.systemPrompt.length > 100, "has a real teaching system prompt");
  assert.equal(peh.source, "builtin");
  assert.ok((peh.allowedTools ?? []).includes("read_file") && !(peh.allowedTools ?? []).includes("write_file"), "read-only tools");
  assert.ok((peh.modelPreference ?? "").length > 0, "runs on its own model");
});

test("loadAllAgents surfaces built-in Pehlichi with ZERO custom setup (no .ikbi/agents/)", async () => {
  const { loadAllAgents, findCustomAgent } = await import("./agent-directory.js");
  const empty = mkdtempSync(join(tmpdir(), "ikbi-noagents-"));
  assert.ok(loadAllAgents(empty).agents.some((a) => a.name === "Pehlichi"), "Pehlichi available with no agents dir");
  assert.ok(findCustomAgent(empty, "peh") === undefined || findCustomAgent(empty, "pehlichi")?.name === "Pehlichi");
  assert.equal(findCustomAgent(empty, "PEHLICHI")?.name, "Pehlichi", "case-insensitive lookup finds the built-in");
});

test("a custom .ikbi/agents/ entry OVERRIDES a built-in of the same name", async () => {
  const { loadAllAgents } = await import("./agent-directory.js");
  const repo = repoWithAgents({ "pehlichi.yaml": "name: Pehlichi\nsystem_prompt: my own reskinned Peh\n" });
  const peh = loadAllAgents(repo).agents.find((a) => a.name === "Pehlichi");
  assert.equal(peh?.systemPrompt, "my own reskinned Peh", "custom wins over built-in");
  assert.equal(peh?.source !== "builtin", true);
});

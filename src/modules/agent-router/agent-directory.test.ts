/**
 * ikbi agent-directory tests — load JSON + YAML personas, the minimal YAML reader, validation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentsDir, findCustomAgent, loadCustomAgents, parseSimpleYaml, validateAgent } from "./agent-directory.js";

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

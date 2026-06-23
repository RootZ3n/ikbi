/**
 * ikbi `agents` CLI tests — list + show, with an injected loader.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentDirectoryResult } from "../modules/agent-router/agent-directory.js";
import { createAgentsCli } from "./agents.js";

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    setExit: (c: number) => void (exit = c),
    get out() { return out; },
    get err() { return err; },
    get exit() { return exit; },
  };
}

const sample: AgentDirectoryResult = {
  dir: "/repo/.ikbi/agents",
  errors: [],
  agents: [
    { name: "reviewer", systemPrompt: "Review carefully.", allowedTools: ["read_file", "search_files"], modelPreference: "deepseek-v4-pro", description: "code reviewer", source: "/repo/.ikbi/agents/reviewer.yaml" },
    { name: "writer", systemPrompt: "Write docs.", source: "/repo/.ikbi/agents/writer.json" },
  ],
};

test("list: shows all agents with tool/model summary", () => {
  const cap = capture();
  createAgentsCli({ ...cap, load: () => sample }).run([]);
  assert.match(cap.out, /Custom agents \(2\)/);
  assert.match(cap.out, /reviewer \(2 tool\(s\), model deepseek-v4-pro\) — code reviewer/);
  assert.match(cap.out, /writer \(all tools\)/);
  assert.match(cap.out, /\/agent <name>/);
});

test("list: empty directory prints guidance", () => {
  const cap = capture();
  createAgentsCli({ ...cap, load: () => ({ dir: "/repo/.ikbi/agents", errors: [], agents: [] }) }).run([]);
  assert.match(cap.out, /No custom agents found/);
});

test("list: reports load errors on stderr", () => {
  const cap = capture();
  createAgentsCli({ ...cap, load: () => ({ ...sample, errors: [{ file: "/repo/.ikbi/agents/bad.json", error: "parse failed" }] }) }).run([]);
  assert.match(cap.err, /could not be loaded/);
  assert.match(cap.err, /bad\.json: parse failed/);
});

test("show <name>: prints the full definition", () => {
  const cap = capture();
  createAgentsCli({ ...cap, load: () => sample }).run(["show", "reviewer"]);
  assert.match(cap.out, /Agent: reviewer/);
  assert.match(cap.out, /Allowed tools: read_file, search_files/);
  assert.match(cap.out, /System prompt:\nReview carefully\./);
});

test("show: unknown name exits 1", () => {
  const cap = capture();
  createAgentsCli({ ...cap, load: () => sample }).run(["show", "ghost"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /no agent named "ghost"/);
});

test("--help prints usage", () => {
  const cap = capture();
  createAgentsCli({ ...cap, load: () => sample }).run(["--help"]);
  assert.match(cap.out, /Usage: ikbi agents/);
});

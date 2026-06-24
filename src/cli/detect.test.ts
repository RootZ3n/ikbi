import assert from "node:assert/strict";
import { test } from "node:test";

import { createDetectCli, renderDetection } from "./detect.js";
import { detectProject, type DetectPorts } from "../modules/project-detection/index.js";

function fakePorts(files: Record<string, string>): DetectPorts {
  const abs = new Map<string, string>();
  for (const [rel, content] of Object.entries(files)) abs.set(`/repo/${rel}`, content);
  return { exists: (p) => abs.has(p), readText: (p) => abs.get(p) };
}

const TS_REPO = {
  "package.json": JSON.stringify({ dependencies: { react: "18" }, devDependencies: { vitest: "1", typescript: "5" } }),
  "tsconfig.json": "{}",
  "pnpm-lock.yaml": "",
};

test("renderDetection shows language, framework, test runner, build tool", () => {
  const d = detectProject("/repo", fakePorts(TS_REPO));
  const out = renderDetection(d);
  assert.match(out, /TypeScript/);
  assert.match(out, /React/);
  assert.match(out, /vitest/);
  assert.match(out, /pnpm/);
});

test("CLI prints a human report with a Next: footer", () => {
  let buf = "";
  const cli = createDetectCli({ stdout: (s) => { buf += s; }, ports: fakePorts(TS_REPO) });
  cli.run(["--repo", "/repo"]);
  assert.match(buf, /Project:/);
  assert.match(buf, /Next:/);
});

test("CLI --json emits parseable JSON and no footer", () => {
  let buf = "";
  const cli = createDetectCli({ stdout: (s) => { buf += s; }, ports: fakePorts(TS_REPO) });
  cli.run(["--repo", "/repo", "--json"]);
  const parsed = JSON.parse(buf) as { primaryLanguage: string };
  assert.equal(parsed.primaryLanguage, "TypeScript");
  assert.ok(!buf.includes("Next:"), "json mode omits the footer");
});

test("CLI --help prints usage without scanning", () => {
  let buf = "";
  const cli = createDetectCli({ stdout: (s) => { buf += s; }, ports: fakePorts({}) });
  cli.run(["--help"]);
  assert.match(buf, /Usage: ikbi detect/);
});

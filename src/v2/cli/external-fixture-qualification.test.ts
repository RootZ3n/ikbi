/**
 * EXTERNAL-FIXTURE QUALIFICATION (V2-020/Phase 26) — REQUIRES `pnpm build`.
 *
 * Every other suite proves ikbi's parts work. This one asks the only question that matters before
 * ikbi is pointed at real outside work: can the SHIPPED BINARY build a project it has never seen?
 *
 * So it creates a DISPOSABLE EXTERNAL repository — its own manifest, its own source, its own
 * operator-declared read-only check — and drives the real `ikbi build` argv against it through the
 * real `dist/cli/index.js`, with a local fake provider standing in for the model. Nothing about the
 * fixture is ikbi's own tree, and nothing in the path is stubbed except the wire.
 *
 * Single strategy on purpose: one candidate, one exam, one adjudication — the cheapest configuration
 * that still exercises the whole canonical lifecycle through to publication.
 */
import { HERMETIC_DEV_KEY_ENV } from "../test-env.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loopbackEgressEnv, startFakeOpenAIProvider, type ScriptedTurn } from "./fake-provider-server.js";
import { initGitRepo } from "./fixture-repo.js";
import { sessionFinalAttempt } from "./session-json.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));

test("QUALIFY: the shipped `ikbi build` binary builds a DISPOSABLE EXTERNAL repo, single strategy", async () => {
  // An external project ikbi has never seen: its own manifest, its own read-only check.
  const repo = initGitRepo({
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify({ name: "external-fixture", version: "1.0.0", scripts: {} }),
    "src/greet.ts": "export const greet = (): string => \"hello\";\n",
    "check.js": "const s=require('fs').readFileSync('src/greet.ts','utf8');process.exit(s.includes('hola')?0:1);\n",
  });
  const script: readonly ScriptedTurn[] = [
    { toolCalls: [{ name: "read_file", args: { path: "src/greet.ts" } }] },
    { toolCalls: [{ name: "replace_file", args: { path: "src/greet.ts", content: "export const greet = (): string => \"hola\";\n" }, observationFrom: "src/greet.ts" }] },
    { toolCalls: [{ name: "finish_candidate", args: { summary: "greet now returns hola", believesComplete: true } }] },
  ];
  const server = await startFakeOpenAIProvider({ script });
  try {
    const state = mkdtempSync(join(tmpdir(), "ikbi-qualify-state-"));
    writeFileSync(join(state, "providers.json"), JSON.stringify({
      providers: [{ id: "p1", kind: "openai-compatible", baseUrl: server.baseUrl, keyless: true }],
      models: [{ id: "m1", role: "builder", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "p1", providerModelId: "m1-wire" }], capabilities: { context_window: 100000, supports_tools: true } }],
    }, null, 2));

    const res = spawnSync(process.execPath, [ENTRY, "build", "make greet return hola", "--repo", repo, "--strategy", "single", "--json"], {
      cwd: mkdtempSync(join(tmpdir(), "ikbi-qualify-cwd-")),
      env: {
        PATH: process.env.PATH ?? "",
        // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
        // and must not depend on the operator's untracked `.env` to start.
        ...HERMETIC_DEV_KEY_ENV,
        HOME: mkdtempSync(join(tmpdir(), "ikbi-qualify-home-")),
        IKBI_STATE_ROOT: state,
        IKBI_MODEL_DRIVER: "m1", IKBI_MODEL_BUILDER: "m1", IKBI_MODEL_CRITIC: "m1",
        IKBI_ALLOW_INSECURE_DEV_KEYS: "true",
        // `node` is deliberately NOT in the default governed-exec allowlist. This suite runs a
        // `node <script>` check, so it grants that permission EXPLICITLY (the override is
        // additive) instead of inheriting it from an operator's untracked `.env`.
        IKBI_GOVERNED_EXEC_ALLOWLIST: "node",
        IKBI_CHECKS: '[{"name":"check","command":"node","args":["check.js"]}]',
        IKBI_RECOVERY_MAX_ATTEMPTS: "1",
        ...loopbackEgressEnv(server),
      },
      encoding: "utf8",
    });
    assert.ok(res.stdout.trim().startsWith("{"), `expected a JSON session receipt:\n${res.stdout}\n---\n${res.stderr}`);
    const r = sessionFinalAttempt(res.stdout);

    // The canonical v2 lifecycle really ran, on a repository ikbi did not own.
    assert.ok(r.runId.startsWith("run_"));
    assert.equal(r.receipt.strategy?.kind, "single");
    assert.ok(r.receipt.stagesEntered.includes("verification"), "the deterministic exam ran");
    assert.equal(r.receipt.verification?.verdict, "pass", "the external project's own check passed on the candidate");
    assert.ok(r.receipt.stagesEntered.includes("criticism"));
    assert.ok(r.receipt.stagesEntered.includes("disposition"));
    // eslint-disable-next-line no-console
    console.log(`QUALIFY receipt: outcome=${r.outcome.kind} verdict=${r.receipt.verification?.verdict} stages=${r.receipt.stagesEntered.join(">")} invocations=${r.receipt.evidence.invocations}`);
  } finally {
    await server.close();
  }
});

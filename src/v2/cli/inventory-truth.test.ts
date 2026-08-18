/**
 * INVENTORY TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * The acceptance criterion, stated as tests:
 *
 *   If the machine can access model M, V2 inventory says M exists.
 *   If the operator merely PREFERS M, that preference does not make M exist.
 *   If the operator stops preferring M, a real M does not disappear.
 *
 * The headline case reproduces the V2-003 defect exactly. v1 mints a registry entry
 * named after the operator's preference (`core/provider/index.ts:124,129,138`) BEFORE
 * `autoDiscoverProviders` runs, so the genuine route is skipped as "already present"
 * (`index.ts:99`). Under V2-003 the fabricated entry was then stripped and the real
 * model vanished: `IKBI_MODEL_DRIVER=gpt-4o` with an OpenAI credential DELETED gpt-4o
 * from the inventory. This suite fails on that implementation and passes on this one.
 *
 * No network call is made. `.test` endpoints and dummy credentials are never contacted —
 * a credential's PRESENCE is the only thing that is ever read.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import type { V2RunResult } from "../core/result.js";
import { loopbackEgressEnv, startFakeOpenAIProvider } from "./fake-provider-server.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** A dummy credential. Never sent anywhere; only its PRESENCE is ever read. */
const OPENAI_KEY = "sk-test-INVENTORYTRUTHNEVERPRINTTHIS";

/** A roster declaring two keyless models, so profiles have something real to pin. */
const PROVIDER = await startFakeOpenAIProvider();
after(() => PROVIDER.close());

const ROSTER = {
  providers: [
    { id: "p1", kind: "openai-compatible", baseUrl: PROVIDER.baseUrl, keyless: true },
    { id: "p2", kind: "openai-compatible", baseUrl: PROVIDER.baseUrl, keyless: true },
  ],
  models: [
    { id: "alpha", role: "builder", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "p1", providerModelId: "alpha-wire" }] },
    { id: "beta", role: "builder", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "p2", providerModelId: "beta-wire" }] },
  ],
};

const profileFor = (name: string, provider: string, model: string) => ({
  name,
  roles: { builder: { provider, model }, critic: { provider, model } },
});

const roots: string[] = [];

function makeStateRoot(roster: unknown = ROSTER): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-inv-"));
  roots.push(root);
  mkdirSync(join(root, "profiles"), { recursive: true });
  writeFileSync(join(root, "providers.json"), JSON.stringify(roster, null, 2));
  for (const p of [profileFor("prof-a", "p1", "alpha"), profileFor("prof-b", "p2", "beta")]) {
    writeFileSync(join(root, "profiles", `${p.name}.json`), JSON.stringify(p, null, 2));
  }
  return root;
}

function runCli(root: string, args: readonly string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-inv-cwd-")),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-inv-home-")),
      IKBI_STATE_ROOT: root,
      // HERMETIC BASE. `ikbi`'s bootstrap also loads the INSTALL-ROOT `.env`
      // (`cli/bootstrap.ts:103`), so this machine's own keys and tier preferences would
      // otherwise leak in and make "no preference" and "no credential" untestable.
      // Blanking a var makes v1's `optStr` treat it as unset; `extraEnv` re-enables one.
      IKBI_MODEL_DRIVER: "",
      IKBI_MODEL_BUILDER: "",
      IKBI_MODEL_CRITIC: "",
      IKBI_ANTHROPIC_API_KEY: "",
      IKBI_MINIMAX_API_KEY: "",
      IKBI_GOOGLE_API_KEY: "",
      IKBI_GROQ_API_KEY: "",
      // A configured OpenAI credential — the auto-discovery precondition for gpt-4o.
      IKBI_OPENAI_API_KEY: OPENAI_KEY,
      ...loopbackEgressEnv(PROVIDER),
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

interface Snapshot {
  readonly ids: readonly string[];
  readonly digest: string;
  readonly routesOf: (id: string) => readonly string[] | undefined;
  readonly raw: V2RunResult;
  readonly stdout: string;
  readonly stderr: string;
}

function inventory(root: string, extraEnv: Record<string, string> = {}): Snapshot {
  const r = runCli(root, ["v2", "build", "an inventory probe", "--repo", REPO, "--json"], extraEnv);
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${r.stdout}\n---\n${r.stderr}`);
  const raw = JSON.parse(r.stdout) as V2RunResult;
  const models = raw.policy?.inventory.models ?? [];
  return {
    ids: models.map((m) => m.id).sort(),
    digest: raw.policy?.inventory.digest ?? "",
    routesOf: (id) => models.find((m) => m.id === id)?.routes.map((route) => `${route.providerId}/${route.providerModelId}`),
    raw,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

const activate = (root: string, name: string): void => {
  const r = runCli(root, ["profile", "use", name]);
  assert.equal(r.status, 0, `activating ${name} failed:\n${r.stdout}\n${r.stderr}`);
};

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("inventory truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── THE hostile reproduction ────────────────────────────────────────────────

test("inventory truth: PREFERRING an auto-discoverable model does not delete it", () => {
  const root = makeStateRoot();

  // The machine has an OpenAI credential, so gpt-4o is genuinely available.
  const plain = inventory(root);
  assert.ok(plain.ids.includes("gpt-4o"), "an OpenAI credential makes gpt-4o available");
  assert.deepEqual(plain.routesOf("gpt-4o"), ["openai/gpt-4o"], "through the genuine provider route");

  // Now merely PREFER it. Under V2-003 this deleted it: v1's preference-named entry
  // suppressed auto-discovery, and the fabricated entry was then stripped.
  const preferred = inventory(root, { IKBI_MODEL_DRIVER: "gpt-4o" });
  assert.ok(preferred.ids.includes("gpt-4o"), "preferring a model must not delete it");
  assert.deepEqual(preferred.routesOf("gpt-4o"), ["openai/gpt-4o"], "and must not reroute it");

  // Membership and capability are identical — the preference changed nothing factual.
  assert.deepEqual(preferred.ids, plain.ids);
  assert.equal(preferred.digest, plain.digest, "a preference is not a capability change");

  // Stop preferring it: it was inventory fact all along, so nothing moves.
  const after = inventory(root);
  assert.ok(after.ids.includes("gpt-4o"));
  assert.equal(after.digest, plain.digest, "the model was already fact — nothing was added back");
});

test("inventory truth: preferring a built-in does not REROUTE it", () => {
  // v1's colliding upsert changed mimo-v2.5 from [mimo, openrouter] to [mimo, deepseek]
  // purely because of `IKBI_MODEL_CRITIC`. A preference must not fabricate a route.
  const root = makeStateRoot();
  const plain = inventory(root);
  const collided = inventory(root, { IKBI_MODEL_CRITIC: "mimo-v2.5" });
  assert.deepEqual(plain.routesOf("mimo-v2.5"), ["mimo/mimo-v2.5", "openrouter/mimo-v2.5"]);
  assert.deepEqual(collided.routesOf("mimo-v2.5"), plain.routesOf("mimo-v2.5"));
  assert.equal(collided.digest, plain.digest);
});

test("inventory truth: a preference for a model that exists NOWHERE cannot invent it", () => {
  const root = makeStateRoot();
  const plain = inventory(root);
  const invented = inventory(root, { IKBI_MODEL_DRIVER: "totally-made-up-model" });
  assert.equal(invented.ids.includes("totally-made-up-model"), false);
  assert.deepEqual(invented.ids, plain.ids);
  assert.equal(invented.digest, plain.digest);
});

// ── built-in coverage ───────────────────────────────────────────────────────

test("inventory truth: every shipped built-in is present with its true route", () => {
  const root = makeStateRoot();
  const snap = inventory(root);
  const expected: Record<string, readonly string[]> = {
    "mimo-v2.5": ["mimo/mimo-v2.5", "openrouter/mimo-v2.5"],
    "mimo-v2.5-pro": ["mimo/mimo-v2.5-pro", "deepseek/mimo-v2.5-pro"],
    "deepseek-chat": ["deepseek/deepseek-chat"],
    "deepseek-reasoner": ["deepseek/deepseek-reasoner"],
    "deepseek-v4-flash": ["deepseek/deepseek-v4-flash"],
    "opus-4.8": ["stub/opus-4.8"],
  };
  for (const [id, routes] of Object.entries(expected)) {
    assert.ok(snap.ids.includes(id), `built-in ${id} is present`);
    assert.deepEqual(snap.routesOf(id), routes, `built-in ${id} keeps its route`);
  }
});

test("inventory truth: built-in membership survives a preference naming ANY of them", () => {
  const root = makeStateRoot();
  const plain = inventory(root);
  for (const id of ["mimo-v2.5", "mimo-v2.5-pro", "deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "opus-4.8"]) {
    const snap = inventory(root, { IKBI_MODEL_DRIVER: id, IKBI_MODEL_CRITIC: id });
    assert.deepEqual(snap.ids, plain.ids, `preferring ${id} changed membership`);
    assert.equal(snap.digest, plain.digest, `preferring ${id} changed the digest`);
  }
});

test("inventory truth: an auto-discoverable family appears only when its credential does", () => {
  const root = makeStateRoot();
  const withKey = inventory(root);
  assert.ok(withKey.ids.includes("gpt-4o"), "the OpenAI credential is configured in this suite");
  // Anthropic has no credential here, so its contribution must be absent.
  assert.equal(withKey.ids.includes("claude-sonnet-4-5"), false, "no Anthropic credential, no Anthropic model");
});

// ── the preference-independence matrix ──────────────────────────────────────

test("inventory truth: MATRIX — identical provider facts give an identical inventory", () => {
  const root = makeStateRoot();
  const baseline = inventory(root);
  const cases: { label: string; run: () => Snapshot }[] = [
    { label: "no override", run: () => inventory(root) },
    { label: "IKBI_MODEL_DRIVER=alpha", run: () => inventory(root, { IKBI_MODEL_DRIVER: "alpha" }) },
    { label: "IKBI_MODEL_DRIVER=beta", run: () => inventory(root, { IKBI_MODEL_DRIVER: "beta" }) },
    { label: "IKBI_MODEL_DRIVER=totally-made-up-model", run: () => inventory(root, { IKBI_MODEL_DRIVER: "totally-made-up-model" }) },
    { label: "IKBI_MODEL_DRIVER=gpt-4o", run: () => inventory(root, { IKBI_MODEL_DRIVER: "gpt-4o" }) },
    {
      label: "active profile A",
      run: () => {
        activate(root, "prof-a");
        return inventory(root);
      },
    },
    {
      label: "active profile B",
      run: () => {
        activate(root, "prof-b");
        return inventory(root);
      },
    },
  ];
  for (const { label, run } of cases) {
    const snap = run();
    assert.deepEqual(snap.ids, baseline.ids, `membership moved under: ${label}`);
    assert.equal(snap.digest, baseline.digest, `inventoryDigest moved under: ${label}`);
  }
});

test("inventory truth: the POLICY moves while the inventory does not", () => {
  const root = makeStateRoot();
  activate(root, "prof-a");
  const a = inventory(root).raw.receipt.configuration!;
  activate(root, "prof-b");
  const b = inventory(root).raw.receipt.configuration!;
  assert.notEqual(a.policyId, b.policyId, "strategy is policy — it moves");
  assert.equal(a.inventoryDigest, b.inventoryDigest, "capability is fact — it does not");
});

// ── the real-change matrix ──────────────────────────────────────────────────

test("inventory truth: a ROSTER model added or removed DOES move the digest", () => {
  const base = inventory(makeStateRoot());
  const extended = inventory(
    makeStateRoot({
      ...ROSTER,
      models: [...ROSTER.models, { id: "gamma", role: "builder", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "p1", providerModelId: "gamma-wire" }] }],
    }),
  );
  assert.ok(extended.ids.includes("gamma"));
  assert.notEqual(base.digest, extended.digest);

  const reduced = inventory(makeStateRoot({ ...ROSTER, models: [ROSTER.models[0]] }));
  assert.equal(reduced.ids.includes("beta"), false);
  assert.notEqual(base.digest, reduced.digest);
});

test("inventory truth: a PROVIDER added or removed DOES move the digest", () => {
  const base = inventory(makeStateRoot());
  const fewer = inventory(makeStateRoot({ providers: [ROSTER.providers[0]], models: [ROSTER.models[0]] }));
  assert.notEqual(base.digest, fewer.digest);
});

test("inventory truth: a ROUTE change on a real model DOES move the digest", () => {
  const base = inventory(makeStateRoot());
  const rerouted = inventory(
    makeStateRoot({
      ...ROSTER,
      models: [{ ...ROSTER.models[0], providers: [{ provider: "p2", providerModelId: "alpha-wire" }] }, ROSTER.models[1]],
    }),
  );
  assert.deepEqual(base.ids, rerouted.ids, "membership is the same");
  assert.notEqual(base.digest, rerouted.digest, "but the capability is not");
});

test("inventory truth: genuinely GAINING a credential DOES move the digest", () => {
  const root = makeStateRoot();
  const without = inventory(root, { IKBI_ANTHROPIC_API_KEY: "" });
  const with_ = inventory(root, { IKBI_ANTHROPIC_API_KEY: "sk-test-ANOTHERDUMMY" });
  assert.equal(without.ids.includes("claude-sonnet-4-5"), false);
  assert.ok(with_.ids.includes("claude-sonnet-4-5"), "a new credential is a real capability change");
  assert.notEqual(without.digest, with_.digest);
});

// ── secrets ─────────────────────────────────────────────────────────────────

test("inventory truth: no credential reaches output, the inventory, or any digest", () => {
  const root = makeStateRoot();
  const snap = inventory(root, { IKBI_MODEL_DRIVER: "gpt-4o" });
  for (const [what, text] of [["stdout", snap.stdout], ["stderr", snap.stderr], ["result", JSON.stringify(snap.raw)]] as const) {
    assert.equal(text.includes(OPENAI_KEY), false, `the OpenAI key leaked into ${what}`);
  }
  const human = runCli(root, ["v2", "build", "probe", "--repo", REPO]);
  assert.equal(human.stdout.includes(OPENAI_KEY), false);
  assert.equal(human.stderr.includes(OPENAI_KEY), false);
  // The credential's PRESENCE is all that is ever recorded.
  const openai = snap.raw.policy?.inventory.providers.find((p) => p.id === "openai");
  assert.equal(openai?.readiness, "configured");
  assert.equal(openai?.credentialPresent, true);
  assert.equal(JSON.stringify(openai).includes(OPENAI_KEY), false);
});

test("inventory truth: readiness is still CONFIGURED, never a reachability claim", () => {
  const snap = inventory(makeStateRoot());
  assert.equal(snap.raw.policy?.inventory.providers.find((p) => p.id === "p1")?.readiness, "keyless");
  assert.equal(JSON.stringify(snap.raw).includes("reachable"), false);
});

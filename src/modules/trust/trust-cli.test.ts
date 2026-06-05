import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { IdentityResolver } from "../../core/identity/resolver.js";
import type { ValidatedIdentity } from "../../core/identity/resolver.js";
import { LockManager } from "../../core/substrate/lock.js";
import { DocumentStore } from "../../core/substrate/store.js";
import type { PersistedTrustState } from "../../core/trust/index.js";
import { TrustSystem } from "../../core/trust/index.js";
import { commands } from "../../cli/registry.js";
import { createTrustCli } from "./cli.js";

// Importing ./cli.js (side effect) registers the live `trust` command.
import "./cli.js";

const silent: Logger = pino({ level: "silent" });
const KEY = "test-trust-mac-key";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ikbi-trustcli-"));
}

function makeTrust(dir: string): TrustSystem {
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<PersistedTrustState>({ dir, locks, logger: silent, fsync: false });
  return new TrustSystem({ store, logger: silent, promoteStreak: 3, demoteStreak: 2, minDistinctOps: 1, hmacKey: KEY });
}

/** A resolver that mints an operator (or agent) identity from a fixed token. */
function makeResolver(agentId: string, tier: string) {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId, kind: tier === "operator" ? "operator" : "agent", defaultTrustTier: tier, tokenHashes: [hashToken("op-secret")] }] }),
    logger: silent,
    now: () => 1000,
  });
  return (claim: { token?: string }): ValidatedIdentity => resolver.resolve(claim);
}

function capture() {
  let out = "";
  let err = "";
  let exit = 0;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    setExit: (c: number) => void (exit = c),
    get out() { return out; },
    get err() { return err; },
    get exit() { return exit; },
  };
}

test("`ikbi trust` is REGISTERED (shows in the command registry)", () => {
  const cmd = commands.get("trust");
  assert.ok(cmd !== undefined, "the trust command is registered at import");
  assert.match(cmd!.usage ?? "", /grant/);
});

test("trust grant: fails CLOSED without an operator token (exit 1, no grant)", async () => {
  const dir = await tmp();
  try {
    const trust = makeTrust(dir);
    const cap = capture();
    const cli = createTrustCli({ trust, operatorToken: undefined, ...cap });
    await cli.grant(["builder-3", "trusted"]);
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /IKBI_OPERATOR_TOKEN/);
    assert.equal(trust.getState("builder-3"), undefined, "no grant was written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trust grant: with an OPERATOR token, grants trusted + prints confirmation", async () => {
  const dir = await tmp();
  try {
    const trust = makeTrust(dir);
    const cap = capture();
    const cli = createTrustCli({ trust, operatorToken: "op-secret", resolveIdentity: makeResolver("operator", "operator"), defaultTrustTier: "probation", ...cap });
    await cli.grant(["builder-3", "trusted"]);
    assert.equal(cap.exit, 0);
    assert.match(cap.out, /builder-3 -> trusted/);
    assert.equal(trust.getState("builder-3")?.tier, "trusted", "the durable grant landed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trust grant: a NON-operator token is REJECTED (the trust gate denies)", async () => {
  const dir = await tmp();
  try {
    const trust = makeTrust(dir);
    const cap = capture();
    const cli = createTrustCli({ trust, operatorToken: "op-secret", resolveIdentity: makeResolver("rogue", "trusted"), ...cap });
    await cli.grant(["builder-3", "trusted"]);
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /rejected/);
    assert.equal(trust.getState("builder-3"), undefined, "no grant by a non-operator");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trust grant: granting the operator apex is REJECTED up front with a clear message", async () => {
  const dir = await tmp();
  try {
    const trust = makeTrust(dir);
    const cap = capture();
    const cli = createTrustCli({ trust, operatorToken: "op-secret", resolveIdentity: makeResolver("operator", "operator"), ...cap });
    await cli.grant(["builder-3", "operator"]);
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /not grantable|ceiling/);
    assert.equal(trust.getState("builder-3"), undefined, "no apex grant");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trust grant: an invalid tier is REJECTED before touching the trust system", async () => {
  const dir = await tmp();
  try {
    const trust = makeTrust(dir);
    const cap = capture();
    const cli = createTrustCli({ trust, operatorToken: "op-secret", resolveIdentity: makeResolver("operator", "operator"), ...cap });
    await cli.grant(["builder-3", "superuser"]);
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /not a valid trust tier/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trust status: reads back a granted tier (operator confirms the grant landed)", async () => {
  const dir = await tmp();
  try {
    const trust = makeTrust(dir);
    const op = makeResolver("operator", "operator")({ token: "op-secret" });
    await trust.grantTier({ agentId: "builder-3", kind: "agent", tier: "trusted", defaultTrustTier: "probation" }, op);
    const cap = capture();
    const cli = createTrustCli({ trust, ...cap });
    await cli.status(["builder-3"]);
    assert.match(cap.out, /builder-3: tier=trusted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trust status: an unknown agent reports no durable state (resolves to the cold floor)", async () => {
  const dir = await tmp();
  try {
    const trust = makeTrust(dir);
    const cap = capture();
    const cli = createTrustCli({ trust, ...cap });
    await cli.status(["ghost"]);
    assert.match(cap.out, /no durable trust state/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

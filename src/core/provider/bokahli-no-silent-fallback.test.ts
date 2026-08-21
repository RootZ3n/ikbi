/**
 * A local refusal must not become a paid API call.
 *
 * This is the one property of the Bokahli integration that cannot be checked by
 * reading the code, because the failure mode is a *success*: the chain falls
 * through, a remote provider answers well, the caller gets a good response, and
 * the only trace is a line on an invoice. Nothing goes red. So the test asserts
 * that the paid provider was never called at all — `calls === 0` — rather than
 * asserting something about the response, which would look identical either way.
 *
 * The distinction being defended: Bokahli returning `MODEL_NOT_QUALIFIED_FOR_TASK`
 * is not an outage. It is the local deployment stating a policy — nothing
 * installed holds qualification for what you asked. Routing around that
 * statement to a provider with no such policy does not solve the problem; it
 * launders it, and bills for the privilege.
 *
 * Falling back is still allowed. It just has to be a decision someone takes with
 * the reason in front of them, which is what throwing gets us.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pino, type Logger } from "pino";

import {
  type AgentIdentity,
  type ModelProvider,
  type ProviderInvocation,
  type ProviderResult,
} from "./contract.js";
import { ProviderInvoker } from "./invoke.js";
import { ModelRegistry } from "./registry.js";
import { BokahliEscalation } from "./providers/bokahli.js";

const ID: AgentIdentity = { agentId: "t", functionalRole: "tester", trustTier: "verified" };
const FREE = { promptPerMTok: 0, completionPerMTok: 0 };
const PAID = { promptPerMTok: 3, completionPerMTok: 15 };

function captureLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "trace" },
    { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
  );
  return { logger, lines };
}

class Spy implements ModelProvider {
  calls = 0;
  constructor(
    readonly id: string,
    private readonly impl: (inv: ProviderInvocation) => Promise<ProviderResult>,
  ) {}
  async invoke(inv: ProviderInvocation): Promise<ProviderResult> {
    this.calls += 1;
    return this.impl(inv);
  }
}

/** bokahli first, an expensive remote second — the shape a real roster would use. */
function chain(bokahliBehaviour: () => Promise<ProviderResult>) {
  const local = new Spy("bokahli", bokahliBehaviour);
  const paid = new Spy("anthropic", async () => ({
    content: "an excellent answer that cost money",
    finishReason: "stop" as const,
    usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
  }));
  const registry = new ModelRegistry({
    models: [{
      id: "local-first",
      providers: [
        { provider: "bokahli", providerModelId: "qwen3.5-35b-a3b.q2-k", cost: FREE },
        { provider: "anthropic", providerModelId: "claude-opus-5", cost: PAID },
      ],
    }],
    providers: [local, paid],
  });
  const { logger, lines } = captureLogger();
  const invoker = new ProviderInvoker({
    registry,
    circuit: { failureThreshold: 5, cooldownMs: 1000, halfOpenMaxTrials: 1 },
    defaultTimeoutMs: 1000,
    logger,
  });
  return { invoker, local, paid, lines };
}

const call = (invoker: ProviderInvoker) =>
  invoker.invokeModel({ model: "local-first", prompt: "a", identity: ID });

test("a local refusal does not reach the paid provider", async () => {
  const { invoker, local, paid } = chain(async () => {
    throw new BokahliEscalation({
      reason: "MODEL_NOT_QUALIFIED_FOR_TASK",
      detail: "no artifact holds qualification for task class 'cited-extraction'",
    });
  });

  await assert.rejects(call(invoker), (e: unknown) => e instanceof BokahliEscalation);

  assert.equal(local.calls, 1);
  assert.equal(paid.calls, 0,
    "the paid provider was invoked on the back of a local policy decision — this "
      + "is the failure that succeeds, returns a good answer, and bills for it");
});

test("the refusal reaches the caller intact, so the fallback can be a decision", async () => {
  const { invoker } = chain(async () => {
    throw new BokahliEscalation({
      reason: "LOCAL_MODEL_SWAP_REQUIRED",
      detail: "the loaded artifact does not satisfy this request",
      swapCandidates: [{ modelId: "qwen3.5-9b.q6-k", coldLoadSeconds: 2.45 }],
    });
  });

  await assert.rejects(call(invoker), (e: unknown) => {
    assert.ok(e instanceof BokahliEscalation);
    assert.equal(e.reason, "LOCAL_MODEL_SWAP_REQUIRED");
    // The caller can act: ask for a swap, priced, rather than guess.
    assert.equal(e.swapCandidates[0]?.modelId, "qwen3.5-9b.q6-k");
    assert.equal(e.swapCandidates[0]?.coldLoadSeconds, 2.45);
    return true;
  });
});

test("the termination is logged with the reason and what was skipped", async () => {
  // An operator seeing an unanswered request needs to find out why without a
  // debugger. A silent stop is only marginally better than a silent fallback.
  const { invoker, lines } = chain(async () => {
    throw new BokahliEscalation({ reason: "REQUIREMENTS_UNMET", detail: "nothing fits" });
  });
  await assert.rejects(call(invoker));

  const stop = lines.find((l) => l["event"] === "chain_terminated_by_local_refusal");
  assert.ok(stop, "the stop must be visible in the log");
  assert.equal(stop["reason"], "REQUIREMENTS_UNMET");
  assert.equal(stop["remainingRoutes"], 1, "it must say what it declined to try");
});

test("RUNTIME_UNHEALTHY does fall through — it means down, not unwilling", async () => {
  // The one escalation that is an outage rather than a decision. Refusing to
  // fall back here would make a restart into an outage for every caller, which
  // is the opposite mistake.
  const { invoker, local, paid } = chain(async () => {
    throw new BokahliEscalation({ reason: "RUNTIME_UNHEALTHY", detail: "backend not answering" });
  });

  const res = await call(invoker);
  assert.equal(res.provider, "anthropic");
  assert.ok(local.calls >= 1);
  assert.equal(paid.calls, 1);
});

test("an ordinary provider failure still falls through", async () => {
  // The guard must not have turned every local failure into a hard stop. A
  // genuine transport fault is exactly what the fallback chain is for.
  const { invoker, paid } = chain(async () => {
    throw new Error("ECONNRESET");
  });
  const res = await call(invoker);
  assert.equal(res.provider, "anthropic");
  assert.equal(paid.calls, 1);
});

test("a successful local answer never reaches the paid provider either", async () => {
  const { invoker, paid } = chain(async () => ({
    content: "answered locally",
    finishReason: "stop" as const,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }));
  const res = await call(invoker);
  assert.equal(res.provider, "bokahli");
  assert.equal(res.cost.usd, 0);
  assert.equal(paid.calls, 0);
});

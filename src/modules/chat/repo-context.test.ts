/**
 * Repo context (large-repo support): when a context-manager factory is wired, a chat session
 * slots a per-turn "possibly-relevant files" carrier into the model context — through the
 * neutralization chokepoint, as isolated UNTRUSTED data — driven by the latest user request.
 * Without a factory (the default), nothing changes.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

// EGRESS FIRST — the provider registry resolves the fetch guard at import.
import "../egress/index.js";

import type { ModelResponse } from "../../core/provider/contract.js";
import { ChatSession, sessionStore, type RepoContextSelector } from "./session.js";

afterEach(() => sessionStore.reset());

const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });

function scripted(responses: ModelResponse[]) {
  const requests: unknown[] = [];
  let i = 0;
  const invoke = (async (req: unknown) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)] ?? stop(""); i += 1; return r; }) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
  return { invoke, requests };
}

/** A fake selector that records the prompt it was asked about and returns fixed paths. */
function fakeSelector(paths: readonly string[]): { sel: RepoContextSelector; prompts: string[] } {
  const prompts: string[] = [];
  const sel: RepoContextSelector = {
    relevant(prompt: string) {
      prompts.push(prompt);
      return paths.map((p, i) => ({ file: { path: p }, score: paths.length - i }));
    },
  };
  return { sel, prompts };
}

test("the repo-context carrier lists relevant files as isolated UNTRUSTED data", async () => {
  const dir = tmp("ikbi-repoctx-");
  const { invoke, requests } = scripted([stop("ok")]);
  const { sel, prompts } = fakeSelector(["src/auth.ts", "src/session.ts"]);
  const s = new ChatSession("s-rc", { invoke, worktree: dir, makeContextManager: () => sel });
  await s.send("fix the auth bug");

  const msgs = (requests[0] as { messages: Array<{ role: string; content: string; untrusted?: boolean }> }).messages;
  const carrier = msgs.find((m) => m.content.includes("Possibly-relevant files"));
  assert.ok(carrier, "the repo-context carrier is present");
  assert.match(carrier!.content, /src\/auth\.ts/);
  assert.match(carrier!.content, /src\/session\.ts/);
  assert.equal(carrier!.untrusted, true, "carried as isolated UNTRUSTED data, not trusted system text");
  assert.equal(msgs[0]?.role, "system");
  assert.ok(!msgs[0]?.content.includes("Possibly-relevant files"), "the system prompt is untouched");
  // It was scored against the latest user request.
  assert.deepEqual(prompts, ["fix the auth bug"]);
});

test("no carrier is added when no context-manager factory is wired (default)", async () => {
  const dir = tmp("ikbi-repoctx-off-");
  const { invoke, requests } = scripted([stop("hi")]);
  const s = new ChatSession("s-rc-off", { invoke, worktree: dir });
  await s.send("hello");
  const msgs = (requests[0] as { messages: Array<{ content: string }> }).messages;
  assert.ok(!msgs.some((m) => m.content.includes("Possibly-relevant files")), "no repo-context message by default");
});

test("no carrier when the selector finds nothing relevant", async () => {
  const dir = tmp("ikbi-repoctx-empty-");
  const { invoke, requests } = scripted([stop("hi")]);
  const { sel } = fakeSelector([]); // nothing relevant
  const s = new ChatSession("s-rc-empty", { invoke, worktree: dir, makeContextManager: () => sel });
  await s.send("hello");
  const msgs = (requests[0] as { messages: Array<{ content: string }> }).messages;
  assert.ok(!msgs.some((m) => m.content.includes("Possibly-relevant files")), "no carrier when nothing scores");
});

test("a selector that throws never breaks the turn (best-effort)", async () => {
  const dir = tmp("ikbi-repoctx-throw-");
  const { invoke, requests } = scripted([stop("still works")]);
  const sel: RepoContextSelector = {
    relevant() {
      throw new Error("index blew up");
    },
  };
  const s = new ChatSession("s-rc-throw", { invoke, worktree: dir, makeContextManager: () => sel });
  const { response } = await s.send("hello");
  assert.equal(response, "still works");
  const msgs = (requests[0] as { messages: Array<{ content: string }> }).messages;
  assert.ok(!msgs.some((m) => m.content.includes("Possibly-relevant files")), "no carrier on selector failure");
});

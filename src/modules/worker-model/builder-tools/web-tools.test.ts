import assert from "node:assert/strict";
import { test } from "node:test";

import type { FetchLike } from "../../../core/provider/providers/openai-compatible.js";
import { htmlToText, parseDdgResults, runWebExtract, runWebSearch, WEB_TOOL_NAMES } from "./web-tools.js";

/** A fake egress-guarded fetch returning a fixed body (or throwing, to model a block). */
function fakeFetch(body: string, opts: { ok?: boolean; status?: number; throwErr?: Error } = {}): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(input);
    if (opts.throwErr) throw opts.throwErr;
    return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => ({}), text: async () => body };
  };
  return { fetch, calls };
}

const DDG_HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fa&rut=x">First <b>Result</b></a>
  <a class="result__snippet">Snippet about the first result.</a>
</div>
<div class="result">
  <a class="result__a" href="https://stackoverflow.com/q/123">SO Answer</a>
  <a class="result__snippet">How to do the thing.</a>
</div>`;

// ── htmlToText ───────────────────────────────────────────────────────────────

test("htmlToText strips scripts/styles/tags and decodes entities", () => {
  const html = `<html><head><style>.x{}</style><script>evil()</script></head><body><h1>Title</h1><p>a &amp; b &lt;c&gt;</p></body></html>`;
  const text = htmlToText(html);
  assert.doesNotMatch(text, /evil|\.x\{/);
  assert.match(text, /Title/);
  assert.match(text, /a & b <c>/);
});

// ── parseDdgResults ──────────────────────────────────────────────────────────

test("parseDdgResults extracts title/url/snippet and decodes the DDG redirect", () => {
  const results = parseDdgResults(DDG_HTML, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.title, "First Result");
  assert.equal(results[0]?.url, "https://docs.example.com/a", "uddg redirect decoded to the real target");
  assert.match(results[0]?.snippet ?? "", /first result/i);
  assert.equal(results[1]?.url, "https://stackoverflow.com/q/123");
});

test("parseDdgResults honors the limit", () => {
  assert.equal(parseDdgResults(DDG_HTML, 1).length, 1);
});

// ── web_search ───────────────────────────────────────────────────────────────

test("WEB_TOOL_NAMES covers the two tools", () => {
  assert.deepEqual([...WEB_TOOL_NAMES].sort(), ["web_extract", "web_search"]);
});

test("web_search queries the DDG html endpoint through the guarded fetch and formats results", async () => {
  const f = fakeFetch(DDG_HTML);
  const out = await runWebSearch({ guardedFetch: f.fetch }, { query: "how to rename export" });
  assert.match(f.calls[0] ?? "", /^https:\/\/html\.duckduckgo\.com\/html\/\?q=how%20to%20rename%20export$/);
  assert.match(out, /1\. First Result/);
  assert.match(out, /https:\/\/docs\.example\.com\/a/);
  assert.match(out, /2\. SO Answer/);
});

test("web_search rejects an empty query", async () => {
  const f = fakeFetch("");
  const out = await runWebSearch({ guardedFetch: f.fetch }, { query: "  " });
  assert.match(out, /requires a non-empty 'query'/);
  assert.equal(f.calls.length, 0, "no fetch on a bad query");
});

test("web_search surfaces an egress block (guarded fetch throws) as a clear error", async () => {
  const f = fakeFetch("", { throwErr: new Error("egress blocked: host not allowlisted") });
  const out = await runWebSearch({ guardedFetch: f.fetch }, { query: "x" });
  assert.match(out, /blocked or failed/);
  assert.match(out, /IKBI_EGRESS_ALLOWLIST/);
});

test("web_search reports 'no results' on an empty page", async () => {
  const f = fakeFetch("<html><body>nothing here</body></html>");
  const out = await runWebSearch({ guardedFetch: f.fetch }, { query: "obscure" });
  assert.match(out, /No results/);
});

// ── web_extract ──────────────────────────────────────────────────────────────

test("web_extract fetches a URL and returns its readable text", async () => {
  const f = fakeFetch("<html><body><h1>Docs</h1><p>Use the patch tool.</p><script>x()</script></body></html>");
  const out = await runWebExtract({ guardedFetch: f.fetch }, { url: "https://docs.example.com/page" });
  assert.equal(f.calls[0], "https://docs.example.com/page");
  assert.match(out, /Docs/);
  assert.match(out, /Use the patch tool\./);
  assert.doesNotMatch(out, /x\(\)/);
});

test("web_extract rejects a non-http(s) URL before fetching", async () => {
  const f = fakeFetch("");
  const out = await runWebExtract({ guardedFetch: f.fetch }, { url: "file:///etc/passwd" });
  assert.match(out, /only supports http\(s\)/);
  assert.equal(f.calls.length, 0, "no fetch for a non-http scheme");
});

test("web_extract surfaces a non-OK HTTP status", async () => {
  const f = fakeFetch("not found", { ok: false, status: 404 });
  const out = await runWebExtract({ guardedFetch: f.fetch }, { url: "https://x.test/missing" });
  assert.match(out, /HTTP 404/);
});

test("web_extract surfaces an egress block", async () => {
  const f = fakeFetch("", { throwErr: new Error("SSRF: private ip blocked") });
  const out = await runWebExtract({ guardedFetch: f.fetch }, { url: "https://169.254.169.254/latest/meta-data" });
  assert.match(out, /blocked or failed/);
});

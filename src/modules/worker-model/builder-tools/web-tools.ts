/**
 * ikbi builder tools — WEB research (web_search / web_extract).
 *
 * Lets the builder research documentation, Stack Overflow, etc. READ-ONLY, no API
 * key, no auth — built-in `fetch` only (Node 22+), no external deps.
 *
 * ── SECURITY: through the EGRESS SSRF GUARD ──────────────────────────────────
 *  All outbound HTTP goes through the egress guard (`resolveFetchGuard()`), the
 *  same SSRF floor every provider call uses: scheme + host-allowlist + internal-IP
 *  checks, DEFAULT-DENY. So these tools FAIL CLOSED until the operator adds the host
 *  (e.g. html.duckduckgo.com, the docs host) to IKBI_EGRESS_ALLOWLIST — exactly the
 *  posture `terminal` has with its binary allowlist. This is deliberate: an
 *  ungoverned fetch from inside the builder would be an SSRF hole (internal services,
 *  cloud metadata). The guard is injected here so it is also unit-testable.
 *
 * TRUST: web content is arbitrary INTERNET data — UNTRUSTED. The builder feeds the
 * result back through the neutralization chokepoint (source mcp_result), so embedded
 * instructions are inert. This module only PRODUCES the result string.
 */

import type { FetchLike } from "../../../core/provider/providers/openai-compatible.js";
import type { ModelTool } from "../../../core/provider/contract.js";

/** What the web tools need: the egress-guarded fetch (SSRF floor). */
export interface WebDeps {
  readonly guardedFetch: FetchLike;
}

/** The web tool names the builder routes to this module. */
export const WEB_TOOL_NAMES: ReadonlySet<string> = new Set(["web_search", "web_extract"]);

const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
/** Cap on extracted text returned (untrusted content stays bounded before the model). */
const MAX_EXTRACT_CHARS = 8_000;
/** Per-request wall-clock budget. */
const WEB_TIMEOUT_MS = 12_000;
const USER_AGENT = "ikbi-build-engine/0.1 (+https://localhost) research";

export const webSearchTool: ModelTool = {
  name: "web_search",
  description:
    "Search the web (DuckDuckGo, no API key) and return the top results as title + url + snippet. Use to find documentation, Stack Overflow answers, etc. Read-only.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      limit: { type: "number", description: `Max results (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS}).` },
    },
    required: ["query"],
  },
};

export const webExtractTool: ModelTool = {
  name: "web_extract",
  description: "Fetch a URL and return its readable text content (HTML tags stripped, bounded). Read-only.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "The http(s) URL to fetch." } },
    required: ["url"],
  },
};

/** Decode common HTML entities found in scraped text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Strip HTML to readable text: drop script/style, remove tags, decode entities, collapse whitespace. */
export function htmlToText(html: string): string {
  const noScript = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const noTags = noScript.replace(/<[^>]+>/g, " ");
  return decodeEntities(noTags).replace(/[ \t ]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

/** DuckDuckGo HTML wraps result links in a redirect; pull out the real target. */
function resolveDdgHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m?.[1] !== undefined) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

/** Parse the DuckDuckGo HTML results page into {title, url, snippet} entries. */
export function parseDdgResults(html: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(htmlToText(sm[1] ?? ""));
  let am: RegExpExecArray | null;
  let i = 0;
  while ((am = anchorRe.exec(html)) !== null && out.length < limit) {
    const url = resolveDdgHref(am[1] ?? "");
    const title = htmlToText(am[2] ?? "");
    if (title.length > 0) out.push({ title, url, snippet: snippets[i] ?? "" });
    i += 1;
  }
  return out;
}

/** The minimal response shape the egress-guarded FetchLike returns. */
type GuardedResponse = Awaited<ReturnType<FetchLike>>;

/** Read a response body as text, bounded. Never throws (returns "" on failure). */
async function readBodyBounded(res: GuardedResponse, maxChars: number): Promise<string> {
  try {
    const text = await res.text();
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  } catch {
    return "";
  }
}

/** web_search: query DuckDuckGo's no-key HTML endpoint through the egress guard. */
export async function runWebSearch(deps: WebDeps, args: Record<string, unknown>): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length === 0) return "ERROR: web_search requires a non-empty 'query'";
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(Math.floor(args.limit), MAX_SEARCH_RESULTS) : DEFAULT_SEARCH_RESULTS;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await deps.guardedFetch(url, { method: "GET", headers: { "User-Agent": USER_AGENT }, body: "", signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
    if (!res.ok) return `ERROR: web_search HTTP ${res.status}`;
    const html = await readBodyBounded(res, 400_000);
    const results = parseDdgResults(html, limit);
    if (results.length === 0) return `No results for "${query}".`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet.length > 0 ? `\n   ${r.snippet}` : ""}`).join("\n\n");
  } catch (e) {
    return `ERROR: web_search blocked or failed: ${e instanceof Error ? e.message : String(e)} (the host may not be in IKBI_EGRESS_ALLOWLIST)`;
  }
}

/** web_extract: fetch a URL and return its readable text, through the egress guard. */
export async function runWebExtract(deps: WebDeps, args: Record<string, unknown>): Promise<string> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (url.length === 0) return "ERROR: web_extract requires a non-empty 'url'";
  if (!/^https?:\/\//i.test(url)) return "ERROR: web_extract only supports http(s) URLs";
  try {
    const res = await deps.guardedFetch(url, { method: "GET", headers: { "User-Agent": USER_AGENT }, body: "", signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
    if (!res.ok) return `ERROR: web_extract HTTP ${res.status}`;
    const body = await readBodyBounded(res, 1_000_000);
    const text = htmlToText(body);
    const bounded = text.length > MAX_EXTRACT_CHARS ? `${text.slice(0, MAX_EXTRACT_CHARS)}\n…(truncated)` : text;
    return bounded.length > 0 ? bounded : "(no readable text content)";
  } catch (e) {
    return `ERROR: web_extract blocked or failed: ${e instanceof Error ? e.message : String(e)} (the host may not be in IKBI_EGRESS_ALLOWLIST)`;
  }
}

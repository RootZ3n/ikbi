/**
 * ikbi shared authentication — bearer-token guard for all HTTP routes.
 *
 * Extracted from tasks.ts so every module (correction-library, spec-artifact,
 * job-cards, tasks, etc.) shares a single auth preHandler instead of each
 * re-implementing or skipping authentication.
 *
 * When IKBI_API_TOKEN is set, every request MUST present a matching
 * `Authorization: Bearer *** header. When unset, the API is open (local-network
 * / Tailscale posture). Read PER REQUEST so the operator can set/clear it
 * without a restart.
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Public prefixes that are exempt from authentication. */
const PUBLIC_PREFIXES: readonly string[] = ["/health", "/ready", "/agent", "/capabilities"];

/** The shared API token (IKBI_API_TOKEN), read per request. Trimmed; empty → undefined. */
function apiToken(): string | undefined {
  const t = process.env.IKBI_API_TOKEN?.trim();
  return t !== undefined && t.length > 0 ? t : undefined;
}

/** Constant-time compare of a presented secret against the configured token (length-safe). */
function tokenMatches(presented: string, token: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the bearer credential from `Authorization: Bearer ***`, or undefined. */
function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim();
}

/** Is this request targeting a public (auth-exempt) path? */
function isPublicPath(url: string): boolean {
  // Strip query string and trailing slash for comparison
  const path = url.split("?")[0]!.replace(/\/+$/, "") || "/";
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * OPTIONAL bearer-auth pre-handler. When IKBI_API_TOKEN is set, reject (401) any request
 * without a matching bearer; when unset, allow (local-network posture).
 *
 * Public endpoints (/health, /ready, /agent, /capabilities) are always exempt.
 */
export async function apiAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isPublicPath(request.url)) return; // public endpoint — no auth required
  const token = apiToken();
  if (token === undefined) return; // no token configured → open (local network)
  const presented = bearerOf(request.headers.authorization);
  if (presented === undefined || !tokenMatches(presented, token)) {
    reply.code(401);
    await reply.send({ error: "unauthorized: a valid Bearer token (IKBI_API_TOKEN) is required" });
  }
}

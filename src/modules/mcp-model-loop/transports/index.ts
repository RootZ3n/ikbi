/**
 * ikbi MCP transports — barrel.
 *
 * Two transport families:
 *   - stdio  — spawns a LOCAL MCP server as a child process (no auth). Unchanged.
 *   - oauth  — the auth layer for REMOTE (HTTP) MCP servers: device-code flow, PKCE helpers,
 *              automatic refresh, and owner-only token storage. (The HTTP transport itself attaches
 *              the bearer token via `authorizationHeader`.)
 */

export { createStdioTransport, type StdioTransportOptions, type SpawnLike, type SpawnedChild } from "./stdio.js";

export {
  TokenStore,
  OAuthError,
  generatePkce,
  startDeviceAuthorization,
  pollDeviceToken,
  deviceCodeFlow,
  refreshAccessToken,
  getValidAccessToken,
  authorizationHeader,
  isExpired,
  type OAuthServerConfig,
  type OAuthDeps,
  type StoredToken,
  type DeviceAuthorization,
  type PkcePair,
} from "./oauth.js";

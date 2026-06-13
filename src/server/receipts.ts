/**
 * ikbi /api/receipts — web-accessible build history.
 *
 * GET /api/receipts              recent receipts, newest last (default: last 50)
 * GET /api/receipts?limit=N      cap the result count
 * GET /api/receipts?task=<id>    filter by task / request id
 * GET /api/receipts?agent=<id>   filter by agent id
 * GET /api/receipts/:id          single receipt by id
 *
 * Read-only: queries the receipt store; no writes, no identity resolution.
 */

import type { FastifyInstance } from "fastify";

import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { registerRoutes } from "./registry.js";

/** The read surface these routes need (injectable for tests). */
export interface ReceiptReader {
  query(filter?: ReceiptQuery): Promise<Receipt[]>;
}

const DEFAULT_LIMIT = 50;

/** A receipt's task id lives in requestId or metadata.taskId (role receipts carry both). */
function taskIdOf(r: Receipt): string | undefined {
  if (r.requestId !== undefined) return r.requestId;
  const t = (r.metadata as Record<string, unknown> | undefined)?.taskId;
  return typeof t === "string" ? t : undefined;
}

/** Build the route registrar. Pass a store for testing; production uses the core singleton. */
export function createReceiptsRouteRegistrar(store: ReceiptReader = coreReceipts): (app: FastifyInstance) => void {
  return (app: FastifyInstance) => {
    app.get<{ Querystring: { limit?: string; task?: string; agent?: string } }>(
      "/api/receipts",
      async (request) => {
        const { limit: limitStr, task, agent } = request.query;

        let limit = DEFAULT_LIMIT;
        if (limitStr !== undefined) {
          const parsed = Number(limitStr);
          if (!Number.isInteger(parsed) || parsed < 0) {
            throw Object.assign(new Error("limit must be a non-negative integer"), { statusCode: 400 });
          }
          limit = parsed;
        }

        const baseFilter: ReceiptQuery = {
          ...(agent !== undefined && agent.length > 0 ? { agentId: agent } : {}),
        };

        let results: Receipt[];
        if (task !== undefined && task.length > 0) {
          // ReceiptQuery has no requestId clause — query then filter in-process.
          const all = await store.query(baseFilter);
          const filtered = all.filter((r) => taskIdOf(r) === task);
          results = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
        } else {
          results = await store.query({ ...baseFilter, limit });
        }

        return { receipts: results, count: results.length };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/receipts/:id",
      async (request) => {
        const { id } = request.params;
        const all = await store.query();
        const found = all.find((r) => r.id === id);
        if (found === undefined) {
          throw Object.assign(new Error(`receipt "${id}" not found`), { statusCode: 404 });
        }
        return found;
      },
    );
  };
}

// Module-scope registration — fired when this file is imported by the module barrel.
registerRoutes("receipts", createReceiptsRouteRegistrar());

/**
 * ikbi /api/timeline — build activity grouped into time buckets.
 *
 * GET /api/timeline              hourly buckets, all receipts
 * GET /api/timeline?period=day   daily buckets
 * GET /api/timeline?from=<ISO>   filter receipts from this time (inclusive)
 * GET /api/timeline?to=<ISO>     filter receipts up to this time (inclusive)
 *
 * Each bucket: { timestamp, builds, successes, failures, totalCostUsd }
 * Buckets returned in chronological order.
 */

import type { FastifyInstance } from "fastify";

import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { registerRoutes } from "./registry.js";

export interface ReceiptReader {
  query(filter?: ReceiptQuery): Promise<Receipt[]>;
}

type Period = "hour" | "day";

interface TimelineBucket {
  timestamp: string;
  builds: number;
  successes: number;
  failures: number;
  totalCostUsd: number;
}

function floorToBucket(timestampMs: number, period: Period): number {
  const d = new Date(timestampMs);
  if (period === "day") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
}

function costOf(r: Receipt): number {
  const cost = (r.metadata as Record<string, unknown> | undefined)?.costUsd;
  return typeof cost === "number" ? cost : 0;
}

export function createTimelineRouteRegistrar(store: ReceiptReader = coreReceipts): (app: FastifyInstance) => void {
  return (app: FastifyInstance) => {
    app.get<{ Querystring: { period?: string; from?: string; to?: string } }>(
      "/api/timeline",
      async (request) => {
        const { period: periodStr, from: fromStr, to: toStr } = request.query;

        let period: Period;
        if (periodStr === undefined || periodStr === "hour") {
          period = "hour";
        } else if (periodStr === "day") {
          period = "day";
        } else {
          throw Object.assign(new Error('period must be "hour" or "day"'), { statusCode: 400 });
        }

        let fromTime: number | undefined;
        let toTime: number | undefined;

        if (fromStr !== undefined) {
          const t = Date.parse(fromStr);
          if (isNaN(t)) throw Object.assign(new Error("from must be a valid ISO date string"), { statusCode: 400 });
          fromTime = t;
        }
        if (toStr !== undefined) {
          const t = Date.parse(toStr);
          if (isNaN(t)) throw Object.assign(new Error("to must be a valid ISO date string"), { statusCode: 400 });
          toTime = t;
        }

        const filter: ReceiptQuery = {
          ...(fromTime !== undefined ? { fromTime } : {}),
          ...(toTime !== undefined ? { toTime } : {}),
        };

        const all = await store.query(filter);

        const buckets = new Map<number, TimelineBucket>();

        for (const r of all) {
          const key = floorToBucket(r.timestamp, period);
          const existing = buckets.get(key);
          const isSuccess = r.outcome.status === "success";
          const isFailure = r.outcome.status === "failure" || r.outcome.status === "rejected";

          if (existing === undefined) {
            buckets.set(key, {
              timestamp: new Date(key).toISOString(),
              builds: 1,
              successes: isSuccess ? 1 : 0,
              failures: isFailure ? 1 : 0,
              totalCostUsd: costOf(r),
            });
          } else {
            existing.builds += 1;
            if (isSuccess) existing.successes += 1;
            if (isFailure) existing.failures += 1;
            existing.totalCostUsd += costOf(r);
          }
        }

        const sorted = [...buckets.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, bucket]) => bucket);

        return { buckets: sorted, period };
      },
    );
  };
}

registerRoutes("timeline", createTimelineRouteRegistrar());

import { Hono } from "hono";

import { getAuditLog } from "../db/audit";
import { getStats } from "../db/stats";
import type { AppEnvironment } from "../env";

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;

function auditLimit(rawLimit: string | undefined): number {
  if (!rawLimit) return DEFAULT_AUDIT_LIMIT;
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_AUDIT_LIMIT;
  return Math.min(limit, MAX_AUDIT_LIMIT);
}

export const systemRouter = new Hono<AppEnvironment>()
  .get("/stats", async (context) => {
    const stats = await getStats(
      context.get("services").prisma,
      context.get("orgId"),
    );
    return context.json({ status: "ok" as const, ...stats });
  })
  .get("/audit-log", async (context) => {
    const entries = await getAuditLog(
      context.get("services").prisma,
      context.get("orgId"),
      auditLimit(context.req.query("limit")),
      context.req.query("action"),
      context.req.query("resource_type"),
    );
    return context.json({ status: "ok" as const, entries });
  });

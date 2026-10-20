import { portableDataSchema } from "../db/portable-data";
export { portableDataSchema } from "../db/portable-data";
import {
  LastSaasError,
  errorResponse,
  type ExportData,
} from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import { Hono } from "hono";

import { getAuditLog } from "../db/audit";
import { exportData, importData } from "../db/export-import";
import { getStats } from "../db/stats";
import type { AppEnvironment } from "../env";
import { requirePermission } from "../middleware/permission";

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;

const manageExport = requirePermission("manage", () => "/system/export");
const manageImport = requirePermission("manage", () => "/system/import");
const readStats = requirePermission("read", () => "/system/stats");
const readAudit = requirePermission("read", () => "/system/audit");

function auditLimit(rawLimit: string | undefined): number {
  if (!rawLimit) return DEFAULT_AUDIT_LIMIT;
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_AUDIT_LIMIT;
  return Math.min(limit, MAX_AUDIT_LIMIT);
}

export const systemRouter = new Hono<AppEnvironment>()
  .get("/stats", readStats, async (context) => {
    const stats = await getStats(
      context.get("services").prisma,
      context.get("orgId"),
    );
    return context.json({ status: "ok" as const, ...stats });
  })
  .get("/audit-log", readAudit, async (context) => {
    const entries = await getAuditLog(
      context.get("services").prisma,
      context.get("orgId"),
      auditLimit(context.req.query("limit")),
      context.req.query("action"),
      context.req.query("resource_type"),
    );
    return context.json({ status: "ok" as const, entries });
  })
  .post("/export", manageExport, async (context) => {
    const data = await exportData(
      context.get("services").prisma,
      context.get("orgId"),
    );
    await context.get("audit")("export_data", "system", null);
    return context.json({ status: "ok" as const, ...data });
  })
  .post("/import", manageImport, async (context) => {
    const parsed = portableDataSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        errorResponse("InvalidRequest", "Invalid portable data"),
        400,
      );
    }
    const { status: _status, ...portableData } = parsed.data;
    let result;
    try {
      result = await importData(
        context.get("services").prisma,
        context.get("orgId"),
        portableData as ExportData,
        {
          actorId: context.get("userId"),
        },
      );
    } catch (error) {
      // A dump can carry a collection the schema validator rejects; that is a
      // bad request, not a server fault.
      if (error instanceof LastSaasError) {
        return context.json(error.toResponse(), 400);
      }
      throw error;
    }
    await context.get("audit")("import_data", "system", null, {
      ...result,
    } as Prisma.InputJsonObject);
    return context.json({ status: "ok" as const, ...result });
  });

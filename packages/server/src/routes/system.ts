import {
  LastSaasError,
  errorResponse,
  type ExportData,
} from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";

import { getAuditLog } from "../db/audit";
import { exportData, importData } from "../db/export-import";
import { getStats } from "../db/stats";
import type { AppEnvironment } from "../env";
import { requirePermission } from "../middleware/permission";

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;

const dateString = z.string().min(1);
const collectionSchema = z.record(z.string(), z.unknown());
const recordSchema = z
  .object({
    id: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
    created_by: z.string(),
    created_at: dateString,
    updated_at: dateString,
  })
  .strict();
const portableDataSchema = z
  .object({
    status: z.literal("ok").optional(),
    version: z.literal(1),
    collections: z.array(
      z
        .object({
          name: z.string().min(1),
          schema: collectionSchema,
          description: z.string(),
          records: z.array(recordSchema),
        })
        .strict(),
    ),
    files: z.array(
      z
        .object({
          id: z.string().min(1),
          path: z.string().min(1),
          filename: z.string().min(1),
          mime_type: z.string().nullable(),
          size_bytes: z.number().int().nonnegative().nullable(),
          collection: z.string().nullable(),
          record_id: z.string().nullable(),
          uploaded_by: z.string(),
          created_at: dateString,
          updated_at: dateString,
        })
        .strict(),
    ),
    policies: z.array(
      z
        .object({
          subject: z.string().min(1),
          resource: z.string().min(1),
          action: z.string().min(1),
        })
        .strict(),
    ),
    role_assignments: z.array(
      z
        .object({ user_id: z.string().min(1), role: z.string().min(1) })
        .strict(),
    ),
    row_filters: z.array(
      z
        .object({
          collection: z.string().min(1),
          role: z.string().min(1),
          action: z.string().min(1),
          condition: z.record(z.string(), z.unknown()),
        })
        .strict(),
    ),
    field_filters: z.array(
      z
        .object({
          collection: z.string().min(1),
          role: z.string().min(1),
          action: z.string().min(1),
          readable_fields: z.array(z.string()),
          writable_fields: z.array(z.string()),
        })
        .strict(),
    ),
    notification_schedules: z.array(
      z
        .object({
          id: z.string().min(1),
          user_id: z.string().min(1),
          dedupe_key: z.string().min(1),
          type: z.string().min(1),
          message: z.string(),
          data: z.record(z.string(), z.unknown()).nullable(),
          in_app: z.boolean(),
          channel: z.string().min(1),
          deliver_at: dateString.nullable(),
          recurrence: z.string().nullable(),
          next_occurrence_at: dateString.nullable(),
          status: z.string().min(1),
          last_enqueued_at: dateString.nullable(),
          created_at: dateString,
          updated_at: dateString,
        })
        .strict(),
    ),
  })
  .strict();

const manageExport = requirePermission("manage", () => "/system/export");
const manageImport = requirePermission("manage", () => "/system/import");

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
  })
  .post("/export", manageExport, async (context) => {
    const data = await exportData(
      context.get("services").prisma,
      context.get("orgId"),
    );
    await context.get("audit")("export_data", "system", null, {});
    return context.json({ status: "ok" as const, ...data });
  })
  .post("/import", manageImport, async (context) => {
    const parsed = portableDataSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        errorResponse(
          "InvalidRequest",
          parsed.error.issues.map((issue) => issue.message).join("; "),
        ),
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

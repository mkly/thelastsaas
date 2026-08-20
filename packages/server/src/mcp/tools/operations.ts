import {
  FileMissingError,
  LastSaasError,
  NOTIFICATION_KINDS,
  genId,
  sanitizePathComponent,
  type ExportData,
} from "@lastsaas/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Prisma } from "@prisma/client";
import { Buffer } from "node:buffer";
import { z } from "zod";

import { addAuditLog, getAuditLog } from "../../db/audit";
import { hasPermission } from "../../db/casbin";
import { exportData, importData } from "../../db/export-import";
import { createFile, deleteFile, getFile, listFiles } from "../../db/files";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "../../db/notification-preferences";
import {
  deleteNotification,
  getNotifications,
  markNotificationRead,
  queueDirectNotification,
} from "../../db/notifications";
import { getStats } from "../../db/stats";
import { InvalidRecurrenceError, parseRecurrence } from "../../lib/recurrence";
import type { PermissionAction } from "../../middleware/permission";
import { scheduleResponse } from "../../routes/notification-schedules";
import { channelPatchSchema } from "../../routes/notifications";
import { portableDataSchema } from "../../routes/system";
import type { McpToolContext } from "../context";

const MAX_PATH_BYTES = 1024;
const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;

type ToolPayload = Record<string, unknown>;

class ToolFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: ToolPayload,
  ) {
    super(message);
  }
}

function toolResult(payload: ToolPayload): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolSuccess(payload: ToolPayload = {}): CallToolResult {
  return toolResult({ status: "ok", ...payload });
}

function toolError(
  code: string,
  message: string,
  details?: ToolPayload,
): CallToolResult {
  const payload = { status: "error", error: code, message, ...details };
  return { ...toolResult(payload), isError: true };
}

async function withToolErrors(
  operation: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ToolFailure) {
      return toolError(error.code, error.message, error.details);
    }
    if (error instanceof FileMissingError || error instanceof LastSaasError) {
      return toolError(error.code, error.message);
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return toolError(
        "FileExistsError",
        "A file with that path already exists in this organization",
      );
    }
    // Route handlers surface an unexpected fault as a bare 500; mirror that
    // here rather than echoing internal error text back to the MCP client.
    console.error("[mcp] tool execution failed", error);
    return toolError("InternalError", "Tool execution failed");
  }
}

async function requireToolPermission(
  context: McpToolContext,
  action: PermissionAction,
  resource: string,
): Promise<void> {
  const allowed = await hasPermission(
    context.services.prisma,
    context.orgId,
    context.userId,
    resource,
    action,
  );
  if (!allowed) {
    throw new ToolFailure(
      "PermissionDenied",
      `User does not have ${action} permission on ${resource}`,
    );
  }
}

function audit(
  context: McpToolContext,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details: Prisma.InputJsonObject = {},
): Promise<void> {
  return addAuditLog(
    context.services.prisma,
    context.orgId,
    context.userId,
    action,
    resourceType,
    resourceId,
    details,
  );
}

function validatePath(path: string): string {
  if (!path || new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) {
    throw new ToolFailure(
      "ValidationError",
      `path must be between 1 and ${MAX_PATH_BYTES} bytes`,
    );
  }
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ToolFailure(
      "ValidationError",
      "path must be a relative slash-separated file path without empty, '.' or '..' segments",
    );
  }
  return path;
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  const maximumEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (value.length > maximumEncodedLength) {
    throw new ToolFailure(
      "PayloadTooLarge",
      `File exceeds the configured ${maxBytes}-byte MCP file limit`,
      { max_bytes: maxBytes },
    );
  }
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new ToolFailure(
      "ValidationError",
      "content_base64 must be canonical RFC 4648 base64",
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new ToolFailure(
      "PayloadTooLarge",
      `File exceeds the configured ${maxBytes}-byte MCP file limit`,
      { max_bytes: maxBytes },
    );
  }
  return bytes;
}

async function* byteInput(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function readLimitedContent(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ToolFailure(
          "PayloadTooLarge",
          `File exceeds the configured ${maxBytes}-byte MCP file limit`,
          { max_bytes: maxBytes },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

const deliverySchema = {
  message: z.string().min(1),
  type: z.string().min(1).default("direct_notification"),
  data: z.record(z.string(), z.unknown()).optional(),
  in_app: z.boolean().optional(),
  channel: z.string().min(1).optional(),
  dedupe_key: z.string().min(1).optional(),
};

function registerFileTools(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "files_list",
    {
      description: "List organization files, optionally below a path prefix.",
      inputSchema: z.object({ prefix: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    ({ prefix }) =>
      withToolErrors(async () => {
        await requireToolPermission(context, "read", "/files");
        if (
          prefix !== undefined &&
          new TextEncoder().encode(prefix).byteLength > MAX_PATH_BYTES
        ) {
          throw new ToolFailure(
            "ValidationError",
            `prefix must not exceed ${MAX_PATH_BYTES} bytes`,
          );
        }
        const files = await listFiles(
          context.services.prisma,
          context.orgId,
          prefix,
        );
        return toolSuccess({ files });
      }),
  );

  server.registerTool(
    "files_get",
    {
      description: "Get metadata for one organization file.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      withToolErrors(async () => {
        await requireToolPermission(context, "read", "/files");
        const file = await getFile(context.services.prisma, context.orgId, id);
        return toolSuccess({ file });
      }),
  );

  server.registerTool(
    "files_upload",
    {
      description:
        "Upload base64 file content. Decoded content is limited by the server's MAX_UPLOAD_SIZE configuration.",
      inputSchema: z.object({
        filename: z.string().min(1),
        content_base64: z.string(),
        path: z.string().optional(),
        mime_type: z.string().min(1).optional(),
      }),
    },
    ({ filename, content_base64, path, mime_type }) =>
      withToolErrors(async () => {
        await requireToolPermission(context, "write", "/files");
        const bytes = decodeBase64(
          content_base64,
          context.config.maxUploadSize,
        );
        const safeFilename = sanitizePathComponent(filename);
        const remotePath = validatePath(path ?? safeFilename);
        const fileId = genId();
        const storageKey = `${context.orgId}/${fileId}`;
        try {
          await context.services.storage.write(storageKey, byteInput(bytes));
          const file = await createFile(context.services.prisma, {
            id: fileId,
            orgId: context.orgId,
            path: remotePath,
            filename: safeFilename,
            mimeType: mime_type ?? null,
            sizeBytes: bytes.byteLength,
            uploadedBy: context.userId,
          });
          await audit(context, "upload_file", "file", fileId, {
            path: remotePath,
          });
          return toolSuccess({ file });
        } catch (error) {
          await context.services.storage
            .delete(storageKey)
            .catch(() => undefined);
          throw error;
        }
      }),
  );

  server.registerTool(
    "files_download",
    {
      description:
        "Download file content as base64. Returned decoded content is limited by the server's MAX_UPLOAD_SIZE configuration.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      withToolErrors(async () => {
        await requireToolPermission(context, "read", "/files");
        const file = await getFile(context.services.prisma, context.orgId, id);
        if (
          file.size_bytes !== null &&
          file.size_bytes > context.config.maxUploadSize
        ) {
          throw new ToolFailure(
            "PayloadTooLarge",
            `File exceeds the configured ${context.config.maxUploadSize}-byte MCP file limit`,
            { max_bytes: context.config.maxUploadSize },
          );
        }
        const content = await context.services.storage.read(
          `${context.orgId}/${file.id}`,
        );
        if (!content) throw new FileMissingError(file.id);
        const bytes = await readLimitedContent(
          content,
          context.config.maxUploadSize,
        );
        return toolSuccess({
          file,
          content_base64: bytes.toString("base64"),
        });
      }),
  );

  server.registerTool(
    "files_delete",
    {
      description: "Delete a file after explicit confirmation.",
      inputSchema: z.object({
        id: z.string().min(1),
        confirm: z.boolean().optional(),
      }),
      annotations: { destructiveHint: true },
    },
    ({ id, confirm }) =>
      withToolErrors(async () => {
        if (confirm !== true) {
          throw new ToolFailure(
            "ConfirmationRequired",
            "Set confirm:true to delete this file",
          );
        }
        await requireToolPermission(context, "delete", "/files");
        const file = await getFile(context.services.prisma, context.orgId, id);
        await context.services.storage.delete(`${context.orgId}/${file.id}`);
        await deleteFile(context.services.prisma, context.orgId, file.id);
        await audit(context, "delete_file", "file", file.id, {
          path: file.path,
        });
        return toolSuccess({ message: "File deleted", id: file.id });
      }),
  );
}

function registerNotificationTools(
  server: McpServer,
  context: McpToolContext,
): void {
  server.registerTool(
    "notifications_list",
    {
      description: "List the authenticated user's notifications.",
      inputSchema: z.object({ unread: z.boolean().default(false) }),
      annotations: { readOnlyHint: true },
    },
    ({ unread }) =>
      withToolErrors(async () => {
        const notifications = await getNotifications(
          context.services.prisma,
          context.orgId,
          context.userId,
          unread,
        );
        return toolSuccess({ notifications });
      }),
  );

  for (const [name, read] of [
    ["notifications_read", true],
    ["notifications_unread", false],
  ] as const) {
    server.registerTool(
      name,
      {
        description: `Mark one notification as ${read ? "read" : "unread"}.`,
        inputSchema: z.object({ id: z.string().min(1) }),
      },
      ({ id }) =>
        withToolErrors(async () => {
          const result = await markNotificationRead(
            context.services.prisma,
            id,
            context.orgId,
            context.userId,
            read,
          );
          if (result.count === 0) {
            throw new ToolFailure("NotFound", "Notification not found");
          }
          await audit(
            context,
            "update_notification_read_status",
            "notification",
            id,
            { read },
          );
          return toolSuccess({ id, read });
        }),
    );
  }

  server.registerTool(
    "notifications_delete",
    {
      description: "Delete one notification.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { destructiveHint: true },
    },
    ({ id }) =>
      withToolErrors(async () => {
        const result = await deleteNotification(
          context.services.prisma,
          id,
          context.orgId,
          context.userId,
        );
        if (result.count === 0) {
          throw new ToolFailure("NotFound", "Notification not found");
        }
        await audit(context, "delete_notification", "notification", id);
        return toolSuccess({ id });
      }),
  );

  server.registerTool(
    "notifications_queue",
    {
      description: "Queue a notification for immediate delivery.",
      inputSchema: z.object({
        subject: z.string().min(1),
        message: z.string().min(1).optional(),
        text: z.string().min(1).optional(),
        html: z.string().min(1).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        type: z.string().min(1).default("direct_notification"),
        in_app: z.boolean().optional(),
        channel: z.enum(["console", "email"]).optional(),
        dedupe_key: z.string().min(1).optional(),
      }),
    },
    ({
      subject,
      message,
      text,
      html,
      data,
      type,
      in_app,
      channel,
      dedupe_key,
    }) =>
      withToolErrors(async () => {
        const id = await queueDirectNotification(
          context.services.prisma,
          context.services.notificationQueue,
          context.orgId,
          context.userId,
          {
            subject,
            type,
            ...(message ? { message } : {}),
            ...(text ? { text } : {}),
            ...(html ? { html } : {}),
            ...(data ? { data } : {}),
            ...(in_app !== undefined ? { inApp: in_app } : {}),
            ...(channel ? { channel } : {}),
            ...(dedupe_key ? { dedupeKey: dedupe_key } : {}),
          },
        );
        await audit(context, "queue_notification", "notification", id, {
          subject,
        });
        return toolSuccess({ id, message: "Notification queued" });
      }),
  );

  server.registerTool(
    "notification_schedules_list",
    {
      description: "List the authenticated user's notification schedules.",
      annotations: { readOnlyHint: true },
    },
    () =>
      withToolErrors(async () => {
        const schedules =
          await context.services.prisma.notificationSchedule.findMany({
            where: { orgId: context.orgId, userId: context.userId },
            orderBy: { createdAt: "desc" },
          });
        return toolSuccess({ schedules: schedules.map(scheduleResponse) });
      }),
  );

  server.registerTool(
    "notification_schedules_create_once",
    {
      description: "Create a one-shot notification schedule.",
      inputSchema: z.object({
        ...deliverySchema,
        deliver_at: z.string().datetime({ offset: true }),
      }),
    },
    (input) =>
      withToolErrors(async () => {
        const schedule =
          await context.services.prisma.notificationSchedule.create({
            data: {
              id: genId(),
              orgId: context.orgId,
              userId: context.userId,
              dedupeKey: input.dedupe_key ?? genId(),
              type: input.type,
              message: input.message,
              ...(input.data
                ? { data: input.data as Prisma.InputJsonObject }
                : {}),
              inApp: input.in_app ?? true,
              channel: input.channel ?? "console",
              deliverAt: new Date(input.deliver_at),
            },
          });
        await audit(
          context,
          "create_notification_schedule",
          "notification_schedule",
          schedule.id,
          { type: input.type },
        );
        return toolSuccess({ schedule: scheduleResponse(schedule) });
      }),
  );

  server.registerTool(
    "notification_schedules_create_recurring",
    {
      description:
        "Create a recurring notification schedule using RFC 5545 DTSTART/RRULE/EXDATE content.",
      inputSchema: z.object({
        ...deliverySchema,
        recurrence: z.string().min(1),
      }),
    },
    (input) =>
      withToolErrors(async () => {
        let nextOccurrenceAt: Date | undefined;
        try {
          const recurrence = parseRecurrence(input.recurrence);
          nextOccurrenceAt =
            recurrence.rule.after(new Date(0), true) ?? undefined;
        } catch (error) {
          if (error instanceof InvalidRecurrenceError) {
            throw new ToolFailure("InvalidRequest", error.message);
          }
          throw error;
        }
        const schedule =
          await context.services.prisma.notificationSchedule.create({
            data: {
              id: genId(),
              orgId: context.orgId,
              userId: context.userId,
              dedupeKey: input.dedupe_key ?? genId(),
              type: input.type,
              message: input.message,
              ...(input.data
                ? { data: input.data as Prisma.InputJsonObject }
                : {}),
              inApp: input.in_app ?? true,
              channel: input.channel ?? "console",
              recurrence: input.recurrence,
              nextOccurrenceAt,
            },
          });
        await audit(
          context,
          "create_notification_schedule",
          "notification_schedule",
          schedule.id,
          { type: input.type },
        );
        return toolSuccess({ schedule: scheduleResponse(schedule) });
      }),
  );

  server.registerTool(
    "notification_schedules_cancel",
    {
      description: "Cancel an active notification schedule.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { destructiveHint: true },
    },
    ({ id }) =>
      withToolErrors(async () => {
        const result =
          await context.services.prisma.notificationSchedule.updateMany({
            where: {
              id,
              orgId: context.orgId,
              userId: context.userId,
              status: "scheduled",
            },
            data: { status: "cancelled", lockedAt: null },
          });
        if (result.count === 0) {
          throw new ToolFailure(
            "NotFound",
            "Active notification schedule not found",
          );
        }
        await audit(
          context,
          "cancel_notification_schedule",
          "notification_schedule",
          id,
        );
        return toolSuccess({
          id,
          message: "Notification schedule cancelled",
        });
      }),
  );

  server.registerTool(
    "notification_preferences_show",
    {
      description: "Show the authenticated user's notification preferences.",
      annotations: { readOnlyHint: true },
    },
    () =>
      withToolErrors(async () => {
        const preferences = await getNotificationPreferences(
          context.services.prisma,
          context.userId,
        );
        return toolSuccess({ preferences });
      }),
  );

  server.registerTool(
    "notification_preferences_set",
    {
      description:
        "Set default preferences, or preferences for one notification kind.",
      inputSchema: z.object({
        kind: z.enum(NOTIFICATION_KINDS).optional(),
        ...channelPatchSchema.shape,
      }),
    },
    ({ kind, in_app, email }) =>
      withToolErrors(async () => {
        if (in_app === undefined && email === undefined) {
          throw new ToolFailure(
            "InvalidRequest",
            "Provide at least one of in_app or email",
          );
        }
        const channels = {
          ...(in_app === undefined ? {} : { in_app }),
          ...(email === undefined ? {} : { email }),
        };
        const preferences = await updateNotificationPreferences(
          context.services.prisma,
          context.userId,
          kind ? { by_kind: { [kind]: channels } } : { default: channels },
        );
        await audit(
          context,
          "update_notification_preferences",
          "notification",
          null,
        );
        return toolSuccess({ preferences });
      }),
  );
}

function registerSystemTools(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "audit_log",
    {
      description: "List organization audit entries.",
      inputSchema: z.object({
        limit: z.number().int().positive().optional(),
        action: z.string().min(1).optional(),
        resource_type: z.string().min(1).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ limit, action, resource_type }) =>
      withToolErrors(async () => {
        await requireToolPermission(context, "read", "/system/audit");
        const entries = await getAuditLog(
          context.services.prisma,
          context.orgId,
          Math.min(limit ?? DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT),
          action,
          resource_type,
        );
        return toolSuccess({ entries });
      }),
  );

  server.registerTool(
    "stats",
    {
      description:
        "Show organization collection, record, file, and storage statistics.",
      annotations: { readOnlyHint: true },
    },
    () =>
      withToolErrors(async () => {
        await requireToolPermission(context, "read", "/system/stats");
        const stats = await getStats(context.services.prisma, context.orgId);
        return toolSuccess(stats);
      }),
  );

  server.registerTool(
    "org_export",
    {
      description: "Export a portable organization dump.",
      annotations: { readOnlyHint: true },
    },
    () =>
      withToolErrors(async () => {
        await requireToolPermission(context, "manage", "/system/export");
        const data = await exportData(context.services.prisma, context.orgId);
        await audit(context, "export_data", "system", null);
        return toolSuccess({ ...data });
      }),
  );

  server.registerTool(
    "org_import",
    {
      description:
        "Import a portable organization dump after explicit confirmation.",
      inputSchema: z.object({
        data: z.unknown(),
        confirm: z.boolean().optional(),
      }),
      annotations: { destructiveHint: true },
    },
    ({ data, confirm }) =>
      withToolErrors(async () => {
        if (confirm !== true) {
          throw new ToolFailure(
            "ConfirmationRequired",
            "Set confirm:true to import organization data",
          );
        }
        await requireToolPermission(context, "manage", "/system/import");
        const parsed = portableDataSchema.safeParse(data);
        if (!parsed.success) {
          throw new ToolFailure(
            "InvalidRequest",
            parsed.error.issues.map((issue) => issue.message).join("; "),
          );
        }
        const { status: _status, ...portableData } = parsed.data;
        const result = await importData(
          context.services.prisma,
          context.orgId,
          portableData as ExportData,
        );
        await audit(context, "import_data", "system", null, {
          ...result,
        } as Prisma.InputJsonObject);
        return toolSuccess({ ...result });
      }),
  );
}

export function registerOperationsTools(
  server: McpServer,
  context: McpToolContext,
): void {
  registerFileTools(server, context);
  registerNotificationTools(server, context);
  registerSystemTools(server, context);
}

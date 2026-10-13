import {
  decodeGrantOptions,
  encodeGrantOptions,
  validateGrantOptions,
} from "./grant-options";
import {
  exportAutomation,
  importAutomation,
  validateAutomation,
} from "./portable-automation";
import { exportSecrets, importSecrets } from "./portable-secrets";
import { portableDataSchema } from "./portable-data";
import { queryProvider } from "./provider";
import {
  collectionCacheKey,
  policyCacheKey,
  invalidateMetadata,
} from "./cache";
import {
  SchemaValidationError,
  validateSchema,
  genId,
  storedNotificationAudience,
  isPlainObject,
  type ExportData,
  type SecretKeyring,
  type ImportResult,
  type Schema,
  type Where,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

import { roleSubject } from "./casbin";
import { validateCollectionRecordData } from "./collections";

export interface SecretBackupOptions {
  includeEncryptedSecrets?: boolean;
  keyring?: SecretKeyring | null;
}

const ROLE_SUBJECT = "role:";
const USER_SUBJECT = "user:";

function jsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function asObject(value: Prisma.JsonValue): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function asSchema(value: Prisma.JsonValue): Schema {
  return asObject(value) as Schema;
}

function asWhere(value: Prisma.JsonValue): Where {
  return asObject(value) as Where;
}

function asStrings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function contractSubject(subject: string, orgId: string): string {
  const prefix = roleSubject(orgId, "");
  return subject.startsWith(prefix)
    ? `${ROLE_SUBJECT}${subject.slice(prefix.length)}`
    : `${USER_SUBJECT}${subject}`;
}

function expandSubject(subject: string, orgId: string): string | null {
  if (subject.startsWith(ROLE_SUBJECT)) {
    const role = subject.slice(ROLE_SUBJECT.length);
    return role ? roleSubject(orgId, role) : null;
  }
  if (subject.startsWith(USER_SUBJECT)) {
    const userId = subject.slice(USER_SUBJECT.length);
    return userId || null;
  }
  return null;
}

async function availableId(
  preferred: string,
  exists: (id: string) => Promise<boolean>,
): Promise<string> {
  return (await exists(preferred)) ? genId() : preferred;
}

async function exportInTransaction(
  prisma: Prisma.TransactionClient,
  orgId: string,
  options: SecretBackupOptions,
): Promise<ExportData> {
  const [collections, files, rules, rowFilters, fieldFilters, schedules] =
    await Promise.all([
      prisma.collection.findMany({
        where: { orgId },
        orderBy: { name: "asc" },
        include: { records: { orderBy: { id: "asc" } } },
      }),
      prisma.file.findMany({
        where: { orgId },
        orderBy: [{ path: "asc" }, { id: "asc" }],
        include: { collection: { select: { name: true } } },
      }),
      prisma.casbinRule.findMany({
        where: { orgId, ptype: { in: ["p", "g"] } },
        orderBy: { id: "asc" },
      }),
      prisma.rowFilter.findMany({
        where: { orgId },
        orderBy: [
          { collection: { name: "asc" } },
          { role: "asc" },
          { action: "asc" },
        ],
        include: { collection: { select: { name: true } } },
      }),
      prisma.fieldFilter.findMany({
        where: { orgId },
        orderBy: [
          { collection: { name: "asc" } },
          { role: "asc" },
          { action: "asc" },
        ],
        include: { collection: { select: { name: true } } },
      }),
      prisma.notificationSchedule.findMany({
        where: { orgId },
        orderBy: { id: "asc" },
      }),
    ]);

  const rolePrefix = roleSubject(orgId, "");
  const policies: ExportData["policies"] = [];
  const roleAssignments: ExportData["role_assignments"] = [];
  for (const rule of rules) {
    if (rule.ptype === "p" && rule.v0 && rule.v1 && rule.v2) {
      policies.push({
        subject: contractSubject(rule.v0, orgId),
        resource: rule.v1,
        action: rule.v2,
        ...decodeGrantOptions(rule.v3),
      });
    } else if (
      rule.ptype === "g" &&
      rule.v0 &&
      rule.v1?.startsWith(rolePrefix)
    ) {
      roleAssignments.push({
        user_id: rule.v0,
        role: rule.v1.slice(rolePrefix.length),
      });
    }
  }
  policies.sort((left, right) =>
    `${left.subject}\0${left.resource}\0${left.action}`.localeCompare(
      `${right.subject}\0${right.resource}\0${right.action}`,
    ),
  );
  roleAssignments.sort((left, right) =>
    `${left.user_id}\0${left.role}`.localeCompare(
      `${right.user_id}\0${right.role}`,
    ),
  );

  return {
    version: 1,
    ...(options.includeEncryptedSecrets
      ? {
          encrypted_secrets: await exportSecrets(
            prisma,
            orgId,
            options.keyring ?? null,
          ),
        }
      : {}),
    ...(await exportAutomation(prisma, orgId)),
    collections: collections.map((collection) => ({
      name: collection.name,
      schema: asSchema(collection.schema),
      description: collection.description,
      records: collection.records.map((record) => ({
        id: record.id,
        data: asObject(record.data),
        created_by: record.createdBy,
        created_at: record.createdAt.toISOString(),
        updated_at: record.updatedAt.toISOString(),
      })),
    })),
    files: files.map((file) => ({
      id: file.id,
      path: file.path,
      filename: file.filename,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes,
      collection: file.collection?.name ?? null,
      record_id: file.recordId,
      uploaded_by: file.uploadedBy,
      created_at: file.createdAt.toISOString(),
      updated_at: file.updatedAt.toISOString(),
    })),
    policies,
    role_assignments: roleAssignments,
    row_filters: rowFilters.map((filter) => ({
      collection: filter.collection.name,
      role: filter.role,
      action: filter.action,
      condition: asWhere(filter.condition),
    })),
    field_filters: fieldFilters.map((filter) => ({
      collection: filter.collection.name,
      role: filter.role,
      action: filter.action,
      readable_fields: asStrings(filter.readableFields),
      writable_fields: asStrings(filter.writableFields),
    })),
    notification_schedules: schedules.map((schedule) => ({
      id: schedule.id,
      user_id: schedule.userId,
      audience: storedNotificationAudience(schedule.audience),
      dedupe_key: schedule.dedupeKey,
      type: schedule.type,
      subject: schedule.subject,
      message: schedule.message,
      data: schedule.data === null ? null : asObject(schedule.data),
      deliver_at: schedule.deliverAt?.toISOString() ?? null,
      recurrence: schedule.recurrence,
      next_occurrence_at: schedule.nextOccurrenceAt?.toISOString() ?? null,
      status: schedule.status,
      last_enqueued_at: schedule.lastEnqueuedAt?.toISOString() ?? null,
      created_at: schedule.createdAt.toISOString(),
      updated_at: schedule.updatedAt.toISOString(),
    })),
  };
}

export async function exportData(
  prisma: PrismaClient,
  orgId: string,
  options: SecretBackupOptions = {},
): Promise<ExportData> {
  return prisma.$transaction((db) => exportInTransaction(db, orgId, options), {
    timeout: 60_000,
  });
}

export async function importData(
  prisma: PrismaClient,
  orgId: string,
  input: ExportData,
  options: Pick<SecretBackupOptions, "keyring"> = {},
): Promise<ImportResult> {
  // The DB entry point validates too: MCP and direct callers must get exactly
  // the same atomic boundary as HTTP imports.
  const parsed = portableDataSchema.safeParse(input);
  if (!parsed.success)
    throw new SchemaValidationError(["Invalid portable data"]);
  const { status: _status, ...data } = parsed.data as ExportData & {
    status?: "ok";
  };
  for (const c of data.collections) {
    const errors = validateSchema(c.schema);
    if (errors.length) throw new SchemaValidationError(errors);
  }
  validateAutomation(data, queryProvider(prisma));
  const result = await prisma.$transaction(
    (db) => importInTransaction(db, orgId, data, options.keyring ?? null),
    { timeout: 60_000 },
  );
  await invalidateMetadata(
    prisma,
    policyCacheKey(orgId),
    ...data.collections.map((c) => collectionCacheKey(orgId, c.name)),
  );
  return result;
}

async function importInTransaction(
  prisma: Prisma.TransactionClient,
  orgId: string,
  data: ExportData,
  keyring: SecretKeyring | null,
): Promise<ImportResult> {
  const importedSecrets = await importSecrets(
    prisma,
    orgId,
    data.encrypted_secrets ?? [],
    keyring,
  );
  let importedRecords = 0,
    skippedRecords = 0,
    importedFiles = 0,
    importedPolicies = 0,
    importedRoleAssignments = 0,
    importedRowFilters = 0,
    importedFieldFilters = 0,
    importedSchedules = 0;
  const warnings: string[] = [];
  const collectionIds = new Map<string, string>();
  const recordIds = new Map<string, string>();
  for (const c of data.collections) {
    let collection = await prisma.collection.findUnique({
      where: { orgId_name: { orgId, name: c.name } },
    });
    if (!collection)
      collection = await prisma.collection.create({
        data: {
          id: genId(),
          orgId,
          name: c.name,
          schema: jsonObject(c.schema),
          description: c.description,
        },
      });
    else if (JSON.stringify(collection.schema) !== JSON.stringify(c.schema))
      warnings.push(
        `Collection '${c.name}' exists with a different schema; using the existing schema`,
      );
    collectionIds.set(c.name, collection.id);
    for (const r of c.records) {
      if (
        validateCollectionRecordData(r.data, asSchema(collection.schema)).length
      ) {
        skippedRecords++;
        continue;
      }
      const id = await availableId(r.id, (id) =>
        prisma.record
          .findUnique({ where: { id }, select: { id: true } })
          .then(Boolean),
      );
      await prisma.record.create({
        data: {
          id,
          orgId,
          collectionId: collection.id,
          data: jsonObject(r.data),
          createdBy: r.created_by || "import",
          createdAt: new Date(r.created_at),
          updatedAt: new Date(r.updated_at),
        },
      });
      recordIds.set(r.id, id);
      importedRecords++;
    }
  }
  const automation = await importAutomation(prisma, orgId, data, collectionIds);
  for (const f of data.row_filters) {
    const collectionId = collectionIds.get(f.collection);
    if (!collectionId) {
      warnings.push(
        `Skipped row filter for missing collection '${f.collection}'`,
      );
      continue;
    }
    const key = { orgId, collectionId, role: f.role, action: f.action };
    await prisma.rowFilter.upsert({
      where: { orgId_collectionId_role_action: key },
      create: { id: genId(), ...key, condition: jsonObject(f.condition) },
      update: { condition: jsonObject(f.condition) },
    });
    importedRowFilters++;
  }
  for (const f of data.field_filters) {
    const collectionId = collectionIds.get(f.collection);
    if (!collectionId) {
      warnings.push(
        `Skipped field filter for missing collection '${f.collection}'`,
      );
      continue;
    }
    const key = { orgId, collectionId, role: f.role, action: f.action };
    await prisma.fieldFilter.upsert({
      where: { orgId_collectionId_role_action: key },
      create: {
        id: genId(),
        ...key,
        readableFields: f.readable_fields,
        writableFields: f.writable_fields,
      },
      update: {
        readableFields: f.readable_fields,
        writableFields: f.writable_fields,
      },
    });
    importedFieldFilters++;
  }
  // IDs may collide when cloning to another organization. Remap per-resource
  // policy paths using the actual imported IDs, before writing policy rows.
  for (const p of data.policies) {
    const subject = expandSubject(p.subject, orgId);
    if (!subject) {
      warnings.push(`Skipped policy with invalid subject '${p.subject}'`);
      continue;
    }
    await validateGrantOptions(prisma, orgId, p.resource, p.action, {
      where: p.where,
      fields: p.fields,
    });
    const rule = {
      orgId,
      ptype: "p",
      v0: subject,
      v1: automation.resourceIds.get(p.resource) ?? p.resource,
      v2: p.action,
      v3: encodeGrantOptions({ where: p.where, fields: p.fields }),
    };
    if (!(await prisma.casbinRule.findFirst({ where: rule }))) {
      await prisma.casbinRule.create({ data: rule });
      importedPolicies++;
    }
  }
  for (const a of data.role_assignments) {
    const rule = {
      orgId,
      ptype: "g",
      v0: a.user_id,
      v1: roleSubject(orgId, a.role),
      v2: null,
    };
    if (!(await prisma.casbinRule.findFirst({ where: rule }))) {
      await prisma.casbinRule.create({ data: rule });
      importedRoleAssignments++;
    }
  }
  for (const f of data.files) {
    if (await prisma.file.findFirst({ where: { orgId, path: f.path } })) {
      warnings.push(`Skipped duplicate file path '${f.path}'`);
      continue;
    }
    const collectionId = f.collection
      ? (collectionIds.get(f.collection) ?? null)
      : null;
    const recordId = f.record_id ? (recordIds.get(f.record_id) ?? null) : null;
    if (f.collection && !collectionId)
      warnings.push(
        `Imported file '${f.path}' without missing collection '${f.collection}'`,
      );
    if (f.record_id && !recordId)
      warnings.push(
        `Imported file '${f.path}' without missing record '${f.record_id}'`,
      );
    const id = await availableId(f.id, (id) =>
      prisma.file
        .findUnique({ where: { id }, select: { id: true } })
        .then(Boolean),
    );
    await prisma.file.create({
      data: {
        id,
        orgId,
        path: f.path,
        filename: f.filename,
        mimeType: f.mime_type,
        sizeBytes: f.size_bytes,
        collectionId,
        recordId,
        uploadedBy: f.uploaded_by,
        createdAt: new Date(f.created_at),
        updatedAt: new Date(f.updated_at),
      },
    });
    importedFiles++;
  }
  for (const s of data.notification_schedules) {
    if (
      !(await prisma.user.findUnique({
        where: { id: s.user_id },
        select: { id: true },
      }))
    ) {
      warnings.push(
        `Skipped notification schedule '${s.dedupe_key}' for missing user '${s.user_id}'`,
      );
      continue;
    }
    if (
      await prisma.notificationSchedule.findUnique({
        where: {
          orgId_userId_dedupeKey: {
            orgId,
            userId: s.user_id,
            dedupeKey: s.dedupe_key,
          },
        },
      })
    ) {
      warnings.push(
        `Skipped duplicate notification schedule '${s.dedupe_key}'`,
      );
      continue;
    }
    const id = await availableId(s.id, (id) =>
      prisma.notificationSchedule
        .findUnique({ where: { id }, select: { id: true } })
        .then(Boolean),
    );
    await prisma.notificationSchedule.create({
      data: {
        id,
        orgId,
        userId: s.user_id,
        audience: storedNotificationAudience(
          s.audience,
        ) as Prisma.InputJsonObject,
        dedupeKey: s.dedupe_key,
        type: s.type,
        subject: s.subject,
        message: s.message,
        data: s.data === null ? Prisma.JsonNull : jsonObject(s.data),
        deliverAt: s.deliver_at && new Date(s.deliver_at),
        recurrence: s.recurrence,
        nextOccurrenceAt:
          s.next_occurrence_at && new Date(s.next_occurrence_at),
        status: "paused",
        lockedAt: null,
        lastEnqueuedAt: s.last_enqueued_at && new Date(s.last_enqueued_at),
        createdAt: new Date(s.created_at),
        updatedAt: new Date(s.updated_at),
      },
    });
    importedSchedules++;
  }
  return {
    ...(data.encrypted_secrets ? { imported_secrets: importedSecrets } : {}),
    imported_collections: data.collections.length,
    imported_records: importedRecords,
    imported_files: importedFiles,
    imported_policies: importedPolicies,
    imported_role_assignments: importedRoleAssignments,
    imported_row_filters: importedRowFilters,
    imported_field_filters: importedFieldFilters,
    imported_notification_schedules: importedSchedules,
    ...automation.counts,
    ...(skippedRecords ? { skipped_records: skippedRecords } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

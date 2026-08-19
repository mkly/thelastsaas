import {
  CollectionExistsError,
  genId,
  isPlainObject,
  type ExportData,
  type ImportResult,
  type Schema,
  type Where,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

import { addPolicy, assignRole, roleSubject } from "./casbin";
import {
  createCollection,
  getCollection,
  validateCollectionRecordData,
} from "./collections";
import { setFieldFilter } from "./fieldFilters";
import { setRowFilter } from "./rowFilters";

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

export async function exportData(
  prisma: PrismaClient,
  orgId: string,
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
      dedupe_key: schedule.dedupeKey,
      type: schedule.type,
      message: schedule.message,
      data: schedule.data === null ? null : asObject(schedule.data),
      in_app: schedule.inApp,
      channel: schedule.channel,
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

export async function importData(
  prisma: PrismaClient,
  orgId: string,
  data: ExportData,
): Promise<ImportResult> {
  let importedCollections = 0;
  let importedRecords = 0;
  let importedFiles = 0;
  let importedPolicies = 0;
  let importedRoleAssignments = 0;
  let importedRowFilters = 0;
  let importedFieldFilters = 0;
  let importedSchedules = 0;
  let skippedRecords = 0;
  const warnings: string[] = [];
  const collectionIds = new Map<string, string>();
  const recordIds = new Map<string, string>();

  for (const collectionData of data.collections) {
    try {
      await createCollection(
        prisma,
        orgId,
        collectionData.name,
        collectionData.schema,
        collectionData.description,
      );
    } catch (error) {
      if (!(error instanceof CollectionExistsError)) throw error;
      const existing = await getCollection(prisma, orgId, collectionData.name);
      if (
        JSON.stringify(asSchema(existing.schema)) !==
        JSON.stringify(collectionData.schema)
      ) {
        warnings.push(
          `Collection '${collectionData.name}' exists with a different schema; using the existing schema`,
        );
      }
    }

    const collection = await getCollection(prisma, orgId, collectionData.name);
    const schema = asSchema(collection.schema);
    collectionIds.set(collectionData.name, collection.id);
    importedCollections += 1;

    for (const record of collectionData.records) {
      if (validateCollectionRecordData(record.data, schema).length > 0) {
        skippedRecords += 1;
        continue;
      }
      const id = await availableId(record.id, async (candidate) =>
        Boolean(
          await prisma.record.findUnique({
            where: { id: candidate },
            select: { id: true },
          }),
        ),
      );
      await prisma.record.create({
        data: {
          id,
          orgId,
          collectionId: collection.id,
          data: jsonObject(record.data),
          createdBy: record.created_by || "import",
          createdAt: new Date(record.created_at),
          updatedAt: new Date(record.updated_at),
        },
      });
      recordIds.set(record.id, id);
      importedRecords += 1;
    }
  }

  for (const filter of data.row_filters) {
    const collectionId = collectionIds.get(filter.collection);
    if (!collectionId) {
      warnings.push(
        `Skipped row filter for missing collection '${filter.collection}'`,
      );
      continue;
    }
    await setRowFilter(
      prisma,
      orgId,
      collectionId,
      filter.role,
      filter.action,
      filter.condition,
    );
    importedRowFilters += 1;
  }

  for (const filter of data.field_filters) {
    const collectionId = collectionIds.get(filter.collection);
    if (!collectionId) {
      warnings.push(
        `Skipped field filter for missing collection '${filter.collection}'`,
      );
      continue;
    }
    await setFieldFilter(
      prisma,
      orgId,
      collectionId,
      filter.role,
      filter.action,
      filter.readable_fields,
      filter.writable_fields,
    );
    importedFieldFilters += 1;
  }

  for (const policy of data.policies) {
    const subject = expandSubject(policy.subject, orgId);
    if (!subject) {
      warnings.push(`Skipped policy with invalid subject '${policy.subject}'`);
      continue;
    }
    if (
      await addPolicy(prisma, orgId, subject, policy.resource, policy.action)
    ) {
      importedPolicies += 1;
    }
  }

  for (const assignment of data.role_assignments) {
    if (await assignRole(prisma, orgId, assignment.user_id, assignment.role)) {
      importedRoleAssignments += 1;
    }
  }

  for (const file of data.files) {
    const collectionId = file.collection
      ? (collectionIds.get(file.collection) ?? null)
      : null;
    const recordId = file.record_id
      ? (recordIds.get(file.record_id) ?? null)
      : null;
    if (file.collection && !collectionId) {
      warnings.push(
        `Imported file '${file.path}' without missing collection '${file.collection}'`,
      );
    }
    if (file.record_id && !recordId) {
      warnings.push(
        `Imported file '${file.path}' without missing record '${file.record_id}'`,
      );
    }
    const id = await availableId(file.id, async (candidate) =>
      Boolean(
        await prisma.file.findUnique({
          where: { id: candidate },
          select: { id: true },
        }),
      ),
    );
    try {
      await prisma.file.create({
        data: {
          id,
          orgId,
          path: file.path,
          filename: file.filename,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes,
          collectionId,
          recordId,
          uploadedBy: file.uploaded_by,
          createdAt: new Date(file.created_at),
          updatedAt: new Date(file.updated_at),
        },
      });
      importedFiles += 1;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        warnings.push(`Skipped duplicate file path '${file.path}'`);
        continue;
      }
      throw error;
    }
  }

  for (const schedule of data.notification_schedules) {
    const user = await prisma.user.findUnique({
      where: { id: schedule.user_id },
      select: { id: true },
    });
    if (!user) {
      warnings.push(
        `Skipped notification schedule '${schedule.dedupe_key}' for missing user '${schedule.user_id}'`,
      );
      continue;
    }
    const id = await availableId(schedule.id, async (candidate) =>
      Boolean(
        await prisma.notificationSchedule.findUnique({
          where: { id: candidate },
          select: { id: true },
        }),
      ),
    );
    try {
      await prisma.notificationSchedule.create({
        data: {
          id,
          orgId,
          userId: schedule.user_id,
          dedupeKey: schedule.dedupe_key,
          type: schedule.type,
          message: schedule.message,
          data:
            schedule.data === null
              ? Prisma.JsonNull
              : jsonObject(schedule.data),
          inApp: schedule.in_app,
          channel: schedule.channel,
          deliverAt: schedule.deliver_at ? new Date(schedule.deliver_at) : null,
          recurrence: schedule.recurrence,
          nextOccurrenceAt: schedule.next_occurrence_at
            ? new Date(schedule.next_occurrence_at)
            : null,
          status: schedule.status,
          lastEnqueuedAt: schedule.last_enqueued_at
            ? new Date(schedule.last_enqueued_at)
            : null,
          createdAt: new Date(schedule.created_at),
          updatedAt: new Date(schedule.updated_at),
        },
      });
      importedSchedules += 1;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        warnings.push(
          `Skipped duplicate notification schedule '${schedule.dedupe_key}'`,
        );
        continue;
      }
      throw error;
    }
  }

  const result: ImportResult = {
    imported_collections: importedCollections,
    imported_records: importedRecords,
    imported_files: importedFiles,
    imported_policies: importedPolicies,
    imported_role_assignments: importedRoleAssignments,
    imported_row_filters: importedRowFilters,
    imported_field_filters: importedFieldFilters,
    imported_notification_schedules: importedSchedules,
  };
  if (skippedRecords > 0) result.skipped_records = skippedRecords;
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

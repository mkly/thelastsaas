import {
  InvalidQueryError,
  RecordNotFoundError,
  SchemaValidationError,
  extractFieldType,
  genId,
  isPlainObject,
  type AggregateRequest,
  type Schema,
  type Where,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

import { getCollection, validateCollectionRecordData } from "./collections";
import { expandRecurrences } from "../lib/recurrence";
import {
  applyOrgScope,
  compileAggregate,
  compileOrderBy,
  compileWhere,
  dialectSql,
  type QueryPostFilter,
} from "./query/compile";

const PROVIDER = "sqlite" as const;

function jsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function dataObject(value: Prisma.JsonValue): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new SchemaValidationError([
      "Corrupt record data in database (expected an object)",
    ]);
  }
  return value;
}

function schemaFromCollection(collection: {
  schema: Prisma.JsonValue;
}): Schema {
  if (!isPlainObject(collection.schema)) {
    throw new SchemaValidationError([
      "Corrupt schema in database (expected an object)",
    ]);
  }
  return collection.schema as Schema;
}

/**
 * Validate record data and normalize date-like schema fields through native
 * Date values before crossing Prisma's JSON boundary. JSON storage represents
 * those Date values as canonical ISO strings.
 */
function validatedData(
  data: Record<string, unknown>,
  schema: Schema,
): Record<string, unknown> {
  const errors = validateCollectionRecordData(data, schema);
  const normalized = { ...data };

  for (const [field, definition] of Object.entries(schema)) {
    const type = extractFieldType(definition);
    if (type !== "date" && type !== "datetime") continue;
    const value = data[field];
    if (value === null || value === undefined || typeof value !== "string") {
      continue;
    }
    const date = new Date(
      type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? `${value}T00:00:00.000Z`
        : value,
    );
    if (Number.isNaN(date.getTime())) {
      errors.push(`Field '${field}': invalid ${type} value`);
    } else {
      normalized[field] = date;
    }
  }

  if (errors.length > 0) throw new SchemaValidationError(errors);
  return JSON.parse(JSON.stringify(normalized)) as Record<string, unknown>;
}

function serializedRecord(
  row: {
    id: string;
    data: Prisma.JsonValue;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
  },
  collection?: string,
) {
  return {
    id: row.id,
    ...(collection === undefined ? {} : { collection }),
    data: dataObject(row.data),
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function rejectDeferredFilters(filters: QueryPostFilter[]): void {
  if (filters.some((filter) => filter.kind === "occurs_between")) {
    throw new InvalidQueryError(
      "'occurs_between' is only supported by record query and count operations",
    );
  }
}

type QueryRow = {
  id: string;
  data: string | Prisma.JsonObject;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

function queryRecordData(row: QueryRow): Record<string, unknown> {
  const data =
    typeof row.data === "string" ? (JSON.parse(row.data) as unknown) : row.data;
  if (!isPlainObject(data)) {
    throw new SchemaValidationError([
      "Corrupt record data in database (expected an object)",
    ]);
  }
  return data;
}

function serializedQueryRecord(
  row: QueryRow,
  data: Record<string, unknown>,
  occurrences?: Date[],
) {
  return {
    id: row.id,
    data,
    created_by: row.created_by,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    ...(occurrences === undefined
      ? {}
      : { occurrences: occurrences.map((date) => date.toISOString()) }),
  };
}

export async function insertRecord(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  data: Record<string, unknown>,
  createdBy = "system",
) {
  const collection = await getCollection(prisma, orgId, collectionName);
  const normalized = validatedData(data, schemaFromCollection(collection));
  const now = new Date();
  const row = await prisma.record.create({
    data: {
      id: genId(),
      orgId,
      collectionId: collection.id,
      data: jsonObject(normalized),
      createdBy,
      createdAt: now,
      updatedAt: now,
    },
  });
  return serializedRecord(row, collectionName);
}

export async function insertRecords(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  records: Record<string, unknown>[],
  createdBy = "system",
) {
  const collection = await getCollection(prisma, orgId, collectionName);
  const schema = schemaFromCollection(collection);
  const ids: string[] = [];
  const errors: Array<{ index: number; errors: string[] }> = [];
  const creates: Prisma.PrismaPromise<unknown>[] = [];

  for (const [index, data] of records.entries()) {
    try {
      const normalized = validatedData(data, schema);
      const id = genId();
      const now = new Date();
      ids.push(id);
      creates.push(
        prisma.record.create({
          data: {
            id,
            orgId,
            collectionId: collection.id,
            data: jsonObject(normalized),
            createdBy,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof SchemaValidationError)) throw error;
      errors.push({ index, errors: error.errors });
    }
  }

  // One transaction makes every accepted record in the request atomic.
  if (creates.length > 0) await prisma.$transaction(creates);
  return {
    inserted: ids.length,
    ids,
    ...(errors.length === 0 ? {} : { errors }),
  };
}

export async function getRecord(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  recordId: string,
  rowFilter?: Where | null,
) {
  const collection = await getCollection(prisma, orgId, collectionName);
  if (rowFilter) {
    const compiled = compileWhere(
      undefined,
      schemaFromCollection(collection),
      PROVIDER,
      { extraWhere: rowFilter },
    );
    rejectDeferredFilters(compiled.postFilters);
    const scoped = applyOrgScope(
      orgId,
      collection.id,
      compiled.sql,
      compiled.params,
    );
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        data: string | Prisma.JsonObject;
        created_by: string;
        created_at: Date;
        updated_at: Date;
      }>
    >(
      dialectSql(
        `SELECT id, data, created_by, created_at, updated_at FROM records WHERE id = ? AND ${scoped.sql}`,
        PROVIDER,
      ),
      recordId,
      ...scoped.params,
    );
    const filtered = rows[0];
    if (!filtered) throw new RecordNotFoundError(recordId);
    return serializedRecord(
      {
        id: filtered.id,
        data:
          typeof filtered.data === "string"
            ? (JSON.parse(filtered.data) as Prisma.JsonObject)
            : filtered.data,
        createdBy: filtered.created_by,
        createdAt: new Date(filtered.created_at),
        updatedAt: new Date(filtered.updated_at),
      },
      collectionName,
    );
  }
  const row = await prisma.record.findFirst({
    where: { id: recordId, orgId, collectionId: collection.id },
  });
  if (!row) throw new RecordNotFoundError(recordId);
  return serializedRecord(row, collectionName);
}

export async function updateRecord(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  recordId: string,
  data: Record<string, unknown>,
  rowFilter?: Where | null,
) {
  const collection = await getCollection(prisma, orgId, collectionName);
  const schema = schemaFromCollection(collection);
  let existing: { data: Prisma.JsonValue } | null;
  if (rowFilter) {
    const compiled = compileWhere(undefined, schema, PROVIDER, {
      extraWhere: rowFilter,
    });
    rejectDeferredFilters(compiled.postFilters);
    const scoped = applyOrgScope(
      orgId,
      collection.id,
      compiled.sql,
      compiled.params,
    );
    const rows = await prisma.$queryRawUnsafe<
      Array<{ data: string | Prisma.JsonObject }>
    >(
      dialectSql(
        `SELECT data FROM records WHERE id = ? AND ${scoped.sql}`,
        PROVIDER,
      ),
      recordId,
      ...scoped.params,
    );
    const filtered = rows[0];
    existing = filtered
      ? {
          data:
            typeof filtered.data === "string"
              ? (JSON.parse(filtered.data) as Prisma.JsonObject)
              : filtered.data,
        }
      : null;
  } else {
    existing = await prisma.record.findFirst({
      where: { id: recordId, orgId, collectionId: collection.id },
      select: { data: true },
    });
  }
  if (!existing) throw new RecordNotFoundError(recordId);

  const normalized = validatedData(
    { ...dataObject(existing.data), ...data },
    schema,
  );
  const row = await prisma.record.update({
    where: { id: recordId },
    data: { data: jsonObject(normalized), updatedAt: new Date() },
  });
  return serializedRecord(row, collectionName);
}

export async function deleteRecord(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  recordId: string,
  rowFilter?: Where | null,
): Promise<void> {
  const collection = await getCollection(prisma, orgId, collectionName);
  if (rowFilter) {
    const compiled = compileWhere(
      undefined,
      schemaFromCollection(collection),
      PROVIDER,
      { extraWhere: rowFilter },
    );
    rejectDeferredFilters(compiled.postFilters);
    const scoped = applyOrgScope(
      orgId,
      collection.id,
      compiled.sql,
      compiled.params,
    );
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      dialectSql(
        `SELECT id FROM records WHERE id = ? AND ${scoped.sql}`,
        PROVIDER,
      ),
      recordId,
      ...scoped.params,
    );
    if (rows.length === 0) throw new RecordNotFoundError(recordId);
  }
  const result = await prisma.record.deleteMany({
    where: { id: recordId, orgId, collectionId: collection.id },
  });
  if (result.count === 0) throw new RecordNotFoundError(recordId);
}

export async function queryRecords(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  where?: Where,
  orderBy?: string,
  limit = 50,
  offset = 0,
  rowFilter?: Where | null,
) {
  const collection = await getCollection(prisma, orgId, collectionName);
  const schema = schemaFromCollection(collection);
  const compiled = compileWhere(where, schema, PROVIDER, {
    extraWhere: rowFilter,
  });
  const recurrenceFilters = compiled.postFilters.filter(
    (filter) => filter.kind === "occurs_between",
  );
  if (recurrenceFilters.length > 1) {
    throw new InvalidQueryError(
      "Only one 'occurs_between' clause may be used in a record query",
    );
  }
  const scoped = applyOrgScope(
    orgId,
    collection.id,
    compiled.sql,
    compiled.params,
  );
  const order = compileOrderBy(orderBy, schema, PROVIDER);
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 1000));
  const safeOffset = Math.max(0, Math.trunc(offset));
  const recurrenceFilter = recurrenceFilters[0];

  if (recurrenceFilter) {
    // Pagination must happen after recurrence expansion. Fetch the SQL-filtered
    // candidate set once so a large offset never turns into repeated database
    // page crawling and records with no occurrence cannot consume a page.
    const recordsSql = dialectSql(
      `SELECT id, data, created_by, created_at, updated_at FROM records WHERE ${scoped.sql} ${order}`,
      PROVIDER,
    );
    const rows = await prisma.$queryRawUnsafe<QueryRow[]>(
      recordsSql,
      ...scoped.params,
    );
    const candidates = rows.map((row) => ({ row, data: queryRecordData(row) }));
    const recurringCandidates = candidates.filter(
      (candidate) => typeof candidate.data[recurrenceFilter.field] === "string",
    );
    const expanded = expandRecurrences(
      recurringCandidates.map(
        (candidate) => candidate.data[recurrenceFilter.field] as string,
      ),
      { from: recurrenceFilter.start, to: recurrenceFilter.end },
    );
    const matching = recurringCandidates.flatMap((candidate, index) => {
      const occurrences = expanded[index] ?? [];
      return occurrences.length === 0
        ? []
        : [serializedQueryRecord(candidate.row, candidate.data, occurrences)];
    });

    return {
      records: matching.slice(safeOffset, safeOffset + safeLimit),
      total: matching.length,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  const countSql = dialectSql(
    `SELECT COUNT(*) AS count FROM records WHERE ${scoped.sql}`,
    PROVIDER,
  );
  const recordsSql = dialectSql(
    `SELECT id, data, created_by, created_at, updated_at FROM records WHERE ${scoped.sql} ${order} LIMIT ? OFFSET ?`,
    PROVIDER,
  );
  const [counts, rows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      countSql,
      ...scoped.params,
    ),
    prisma.$queryRawUnsafe<QueryRow[]>(
      recordsSql,
      ...scoped.params,
      safeLimit,
      safeOffset,
    ),
  ]);

  return {
    records: rows.map((row) =>
      serializedQueryRecord(row, queryRecordData(row)),
    ),
    total: Number(counts[0]?.count ?? 0),
    limit: safeLimit,
    offset: safeOffset,
  };
}

export async function countRecords(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  where?: Where,
  rowFilter?: Where | null,
): Promise<number> {
  const result = await queryRecords(
    prisma,
    orgId,
    collectionName,
    where,
    undefined,
    1,
    0,
    rowFilter,
  );
  return result.total;
}

export async function aggregateRecords(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  request: AggregateRequest,
  rowFilter?: Where | null,
) {
  const collection = await getCollection(prisma, orgId, collectionName);
  const compiled = compileAggregate(
    request,
    schemaFromCollection(collection),
    PROVIDER,
    orgId,
    collection.id,
    { extraWhere: rowFilter },
  );
  rejectDeferredFilters(compiled.postFilters);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    dialectSql(compiled.sql, PROVIDER),
    ...compiled.params,
  );
  return {
    rows: rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "bigint" ? Number(value) : value,
        ]),
      ),
    ),
    columns: compiled.columns,
  };
}

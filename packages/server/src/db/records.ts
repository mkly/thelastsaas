import { synchronizeRecordLinks } from "./record-links";
import { relationshipPredicates } from "./relationship-query";
import type { Principal } from "./query/compile";
import { isDeepStrictEqual } from "node:util";
import { sql, queryBuilder, queryRows } from "./query/kysely";
import {
  InvalidQueryError,
  RecordNotFoundError,
  RelationshipConflictError,
  PermissionDeniedError,
  SchemaValidationError,
  extractFieldType,
  genId,
  isPlainObject,
  type AggregateRequest,
  type JsonObject,
  type RecordMutationEvent,
  type Schema,
  type Where,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

import { queryProvider } from "./provider";
import {
  getCollection,
  getCollectionInTransaction,
  validateCollectionRecordData,
} from "./collections";
import { withUnitOfWork, type UnitOfWork } from "./unit-of-work";
import { publishRecordMutation } from "./record-mutations";
import {
  assertWritableFields,
  filterReadableData,
  isFieldReadable,
  type ResolvedFieldFilter,
} from "./fieldFilters";
import { expandRecurrences } from "../lib/recurrence";
import {
  applyOrgScope,
  compileAggregate,
  compileOrderBy,
  compileWhere,
  type QueryPostFilter,
} from "./query/compile";

import {
  assertGrantedWrite,
  evaluateGrants,
  grantFieldFilter,
  grantProjection,
  grantWhere,
  matchingGrants,
  queryGrantWhere,
  type RecordGrants,
} from "./record-grants";

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
  fieldFilter?: ResolvedFieldFilter | null,
) {
  return {
    id: row.id,
    ...(collection === undefined ? {} : { collection }),
    data: filterReadableData(dataObject(row.data), fieldFilter),
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
  fieldFilter?: ResolvedFieldFilter | null,
) {
  return {
    id: row.id,
    data: filterReadableData(data, fieldFilter),
    created_by: row.created_by,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    ...(occurrences === undefined
      ? {}
      : { occurrences: occurrences.map((date) => date.toISOString()) }),
  };
}

/** Full snapshots stay internal; public responses keep their field projection. */
function createMutation(
  row: { id: string; data: Prisma.JsonValue; createdAt: Date },
  collection: string,
): RecordMutationEvent {
  const after = dataObject(row.data) as JsonObject;
  return {
    mutation_id: genId(),
    record_id: row.id,
    collection,
    event: "create",
    occurred_at: row.createdAt.toISOString(),
    before: null,
    after,
    changed_fields: Object.keys(after).sort(),
  };
}

export async function insertRecord(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  data: Record<string, unknown>,
  createdBy = "system",
  fieldFilter?: ResolvedFieldFilter | null,
  grants?: RecordGrants,
) {
  return withUnitOfWork(
    { prisma, provider: queryProvider(prisma) },
    async (context) => {
      const { record } = await insertRecordInTransaction(
        context,
        orgId,
        collectionName,
        data,
        createdBy,
        fieldFilter,
        grants,
      );
      return record;
    },
  );
}

/** Join the caller's transaction; failures must propagate to its owner. */
export async function insertRecordInTransaction(
  context: UnitOfWork,
  orgId: string,
  collectionName: string,
  data: Record<string, unknown>,
  createdBy = "system",
  fieldFilter?: ResolvedFieldFilter | null,
  grants?: RecordGrants,
) {
  const { db, provider } = context;
  const collection = await getCollectionInTransaction(
    db,
    orgId,
    collectionName,
  );
  assertWritableFields(data, fieldFilter);
  const schema = schemaFromCollection(collection);
  const normalized = validatedData(data, schema);
  const now = new Date();
  const id = genId();
  if (grants) {
    const matches = await evaluateGrants(
      db,
      grants,
      { id, data: normalized, createdBy, createdAt: now, updatedAt: now },
      schema,
      provider,
    );
    fieldFilter = grantFieldFilter(
      assertGrantedWrite(grants, matches, matches, Object.keys(data)),
    );
  }
  const row = await db.record.create({
    data: {
      id,
      orgId,
      collectionId: collection.id,
      data: jsonObject(normalized),
      createdBy,
      createdAt: now,
      updatedAt: now,
    },
  });
  await synchronizeRecordLinks(
    context,
    orgId,
    row.id,
    schema,
    null,
    normalized,
    createdBy,
  );
  const mutation = createMutation(row, collectionName);
  await publishRecordMutation(
    context,
    orgId,
    mutation,
    {
      before: null,
      after: row,
    },
    collection.id,
    createdBy,
  );
  return {
    record: serializedRecord(row, collectionName, fieldFilter),
    mutation,
  };
}

export async function insertRecords(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  records: Record<string, unknown>[],
  createdBy = "system",
  fieldFilter?: ResolvedFieldFilter | null,
  grants?: RecordGrants,
) {
  return withUnitOfWork(
    { prisma, provider: queryProvider(prisma) },
    async (context) => {
      const { result } = await insertRecordsInTransaction(
        context,
        orgId,
        collectionName,
        records,
        createdBy,
        fieldFilter,
        grants,
      );
      return result;
    },
    // Unbounded batches would otherwise hit Prisma's 5s interactive default.
    { timeout: 30_000 },
  );
}

/** Partial schema validation is preserved; persistence failures are never swallowed. */
export async function insertRecordsInTransaction(
  context: UnitOfWork,
  orgId: string,
  collectionName: string,
  records: Record<string, unknown>[],
  createdBy = "system",
  fieldFilter?: ResolvedFieldFilter | null,
  grants?: RecordGrants,
) {
  const { db, provider } = context;
  const collection = await getCollectionInTransaction(
    db,
    orgId,
    collectionName,
  );
  const schema = schemaFromCollection(collection);
  const errors: Array<{ index: number; errors: string[] }> = [];
  const creates: Prisma.RecordCreateManyInput[] = [];

  for (const data of records) assertWritableFields(data, fieldFilter);

  for (const [index, data] of records.entries()) {
    try {
      const normalized = validatedData(data, schema);
      const id = genId();
      const now = new Date();
      if (grants) {
        const matches = await evaluateGrants(
          db,
          grants,
          { id, data: normalized, createdBy, createdAt: now, updatedAt: now },
          schema,
          provider,
        );
        assertGrantedWrite(grants, matches, matches, Object.keys(data));
      }
      await synchronizeRecordLinks(
        context,
        orgId,
        id,
        schema,
        null,
        normalized,
        createdBy,
        true,
      );
      creates.push({
        id,
        orgId,
        collectionId: collection.id,
        data: jsonObject(normalized),
        createdBy,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (!(error instanceof SchemaValidationError)) throw error;
      errors.push({ index, errors: error.errors });
    }
  }

  const mutations: RecordMutationEvent[] = [];
  // The supplied context owns atomicity; never open a nested transaction.
  for (const data of creates) {
    const row = await db.record.create({ data });
    await synchronizeRecordLinks(
      context,
      orgId,
      row.id,
      schema,
      null,
      dataObject(row.data),
      createdBy,
    );
    const mutation = createMutation(row, collectionName);
    await publishRecordMutation(
      context,
      orgId,
      mutation,
      {
        before: null,
        after: row,
      },
      collection.id,
      createdBy,
    );
    mutations.push(mutation);
  }
  return {
    result: {
      inserted: mutations.length,
      ids: mutations.map((mutation) => mutation.record_id),
      ...(errors.length === 0 ? {} : { errors }),
    },
    mutations,
  };
}

export async function getRecord(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  recordId: string,
  rowFilter?: Where | null,
  fieldFilter?: ResolvedFieldFilter | null,
  grants?: RecordGrants,
) {
  const provider = queryProvider(prisma);
  const collection = await getCollection(prisma, orgId, collectionName);
  if (grants) rowFilter = grantWhere(grants);
  const projection = grants
    ? grantProjection(grants, schemaFromCollection(collection), provider)
    : undefined;
  if (rowFilter) {
    const compiled = compileWhere(
      undefined,
      schemaFromCollection(collection),
      provider,
      { extraWhere: rowFilter },
    );
    rejectDeferredFilters(compiled.postFilters);
    const scoped = applyOrgScope(orgId, collection.id, compiled.expression);
    const rows = await queryRows<QueryRow>(
      prisma,
      provider,
      queryBuilder(provider)
        .selectFrom("records")
        .select(["id", "data", "created_by", "created_at", "updated_at"])
        .select(projection ?? [])
        .where("id", "=", recordId)
        .where(sql<boolean>`${scoped}`),
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
      grants ? grantFieldFilter(matchingGrants(grants, filtered)) : fieldFilter,
    );
  }
  const row = await prisma.record.findFirst({
    where: { id: recordId, orgId, collectionId: collection.id },
  });
  if (!row) throw new RecordNotFoundError(recordId);
  return serializedRecord(row, collectionName, fieldFilter);
}

export async function updateRecord(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  recordId: string,
  data: Record<string, unknown>,
  rowFilter?: Where | null,
  fieldFilter?: ResolvedFieldFilter | null,
  grants?: RecordGrants,
  actorId = "system",
) {
  return withUnitOfWork(
    { prisma, provider: queryProvider(prisma) },
    async (context) => {
      const { record } = await updateRecordInTransaction(
        context,
        orgId,
        collectionName,
        recordId,
        data,
        rowFilter,
        fieldFilter,
        grants,
        actorId,
      );
      return record;
    },
  );
}

/** Join the caller's transaction, retaining the snapshot used to authorize CAS. */
export async function updateRecordInTransaction(
  context: UnitOfWork,
  orgId: string,
  collectionName: string,
  recordId: string,
  data: Record<string, unknown>,
  rowFilter?: Where | null,
  fieldFilter?: ResolvedFieldFilter | null,
  grants?: RecordGrants,
  actorId = "system",
) {
  const { db, provider } = context;
  const collection = await getCollectionInTransaction(
    db,
    orgId,
    collectionName,
  );
  assertWritableFields(data, fieldFilter);
  const schema = schemaFromCollection(collection);
  let existing;
  if (rowFilter && !grants) {
    const compiled = compileWhere(undefined, schema, provider, {
      extraWhere: rowFilter,
    });
    rejectDeferredFilters(compiled.postFilters);
    const scoped = applyOrgScope(orgId, collection.id, compiled.expression);
    const rows = await queryRows<QueryRow>(
      db,
      provider,
      sql`SELECT id, data, created_by, created_at, updated_at FROM records WHERE id = ${recordId} AND ${scoped}`,
    );
    const row = rows[0];
    existing = row
      ? {
          id: row.id,
          data: queryRecordData(row) as Prisma.JsonObject,
          createdBy: row.created_by,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        }
      : null;
  } else {
    existing = await db.record.findFirst({
      where: { id: recordId, orgId, collectionId: collection.id },
    });
  }
  if (!existing) throw new RecordNotFoundError(recordId);
  const before = grants
    ? await evaluateGrants(db, grants, existing, schema, provider)
    : undefined;
  if (before && !before.some(Boolean)) throw new RecordNotFoundError(recordId);
  const normalized = validatedData(
    { ...dataObject(existing.data), ...data },
    schema,
  );
  const updatedAt = new Date();
  if (grants && before) {
    const after = await evaluateGrants(
      db,
      grants,
      { ...existing, data: normalized, updatedAt },
      schema,
      provider,
    );
    fieldFilter = grantFieldFilter(
      assertGrantedWrite(grants, before, after, Object.keys(data)),
    );
  }
  const updated = await db.record.updateMany({
    where: {
      id: recordId,
      orgId,
      collectionId: collection.id,
      data: { equals: existing.data as Prisma.InputJsonValue },
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    },
    data: { data: jsonObject(normalized), updatedAt },
  });
  if (updated.count !== 1)
    throw new PermissionDeniedError(
      "Record changed during update; retry the request",
    );
  await synchronizeRecordLinks(
    context,
    orgId,
    recordId,
    schema,
    dataObject(existing.data),
    normalized,
    actorId,
  );
  const previous = dataObject(existing.data) as JsonObject;
  const after = normalized as JsonObject;
  const changedFields = [
    ...new Set([...Object.keys(previous), ...Object.keys(after)]),
  ]
    .filter((field) => !isDeepStrictEqual(previous[field], after[field]))
    .sort();
  const mutation: RecordMutationEvent | null =
    changedFields.length === 0
      ? null
      : {
          mutation_id: genId(),
          record_id: recordId,
          collection: collectionName,
          event: "update",
          occurred_at: updatedAt.toISOString(),
          before: previous,
          after,
          changed_fields: changedFields,
        };
  if (mutation)
    await publishRecordMutation(
      context,
      orgId,
      mutation,
      {
        before: existing,
        after: { ...existing, data: after, updatedAt },
      },
      collection.id,
      actorId,
    );
  return {
    record: serializedRecord(
      { ...existing, data: after, updatedAt },
      collectionName,
      fieldFilter,
    ),
    mutation,
  };
}

export async function deleteRecord(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  recordId: string,
  rowFilter?: Where | null,
  grants?: RecordGrants,
  actorId = "system",
): Promise<void> {
  await withUnitOfWork({ prisma, provider: queryProvider(prisma) }, (context) =>
    deleteRecordInTransaction(
      context,
      orgId,
      collectionName,
      recordId,
      rowFilter,
      grants,
      actorId,
    ),
  );
}

/** DELETE RETURNING authorizes and captures the deleted snapshot atomically. */
export async function deleteRecordInTransaction(
  context: UnitOfWork,
  orgId: string,
  collectionName: string,
  recordId: string,
  rowFilter?: Where | null,
  grants?: RecordGrants,
  actorId = "system",
) {
  const { db, provider } = context;
  const collection = await getCollectionInTransaction(
    db,
    orgId,
    collectionName,
  );
  const compiled = compileWhere(
    grants ? grantWhere(grants) : undefined,
    schemaFromCollection(collection),
    provider,
    grants ? undefined : { extraWhere: rowFilter },
  );
  rejectDeferredFilters(compiled.postFilters);
  const scoped = applyOrgScope(orgId, collection.id, compiled.expression);
  // Target locks coordinate delete checks with FK-backed reference insertion.
  const targets = await queryRows<{ id: string }>(
    db,
    provider,
    sql`SELECT id FROM records WHERE id = ${recordId} AND ${scoped} ${provider === "postgresql" ? sql`FOR UPDATE` : sql``}`,
  );
  if (!targets.length) throw new RecordNotFoundError(recordId);
  await db.recordReference.deleteMany({ where: { orgId, sourceId: recordId } });
  if (await db.recordReference.count({ where: { orgId, targetId: recordId } }))
    throw new RelationshipConflictError();
  const rows = await queryRows<QueryRow>(
    db,
    provider,
    sql`DELETE FROM records WHERE id = ${recordId} AND ${scoped} RETURNING id, data, created_by, created_at, updated_at`,
  );
  const row = rows[0];
  if (!row) throw new RecordNotFoundError(recordId);
  const before = queryRecordData(row) as JsonObject;
  const mutation: RecordMutationEvent = {
    mutation_id: genId(),
    record_id: row.id,
    collection: collectionName,
    event: "delete",
    occurred_at: new Date().toISOString(),
    before,
    after: null,
    changed_fields: Object.keys(before).sort(),
  };
  await publishRecordMutation(
    context,
    orgId,
    mutation,
    {
      before: {
        id: row.id,
        data: before,
        createdBy: row.created_by,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      },
      after: null,
    },
    collection.id,
    actorId,
  );
  return {
    mutation,
    // Internal authorization snapshot for transaction response replay. Capture
    // the exact deleted row, including metadata used by row conditions.
    snapshot: serializedRecord(
      {
        id: row.id,
        data: before,
        createdBy: row.created_by,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      },
      collectionName,
    ),
  };
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
  fieldFilter?: ResolvedFieldFilter | null,
  grants?: RecordGrants,
  principal?: Principal,
) {
  const provider = queryProvider(prisma);
  const collection = await getCollection(prisma, orgId, collectionName);
  const schema = schemaFromCollection(collection);
  const relations = await relationshipPredicates(
    prisma,
    provider,
    orgId,
    schema,
    where,
    principal,
  );
  const referenced = new Set<string>();
  const isAllowed = (field: string) => {
    referenced.add(field);
    return grants ? true : isFieldReadable(field, fieldFilter);
  };
  // Collect query/sort references before deriving the permitted input rows.
  compileWhere(where, schema, provider, {
    isFieldAllowed: isAllowed,
    relationshipPredicates: relations,
  });
  const order = compileOrderBy(orderBy, schema, provider, {
    isFieldAllowed: isAllowed,
  });
  if (grants) rowFilter = queryGrantWhere(grants, referenced);
  const projection = grants
    ? grantProjection(grants, schema, provider)
    : undefined;
  const compiled = compileWhere(where, schema, provider, {
    relationshipPredicates: relations,
    extraWhere: rowFilter,
    isFieldAllowed: isAllowed,
  });
  const recurrenceFilters = compiled.postFilters.filter(
    (filter) => filter.kind === "occurs_between",
  );
  if (recurrenceFilters.length > 1) {
    throw new InvalidQueryError(
      "Only one 'occurs_between' clause may be used in a record query",
    );
  }
  const scoped = applyOrgScope(orgId, collection.id, compiled.expression);
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 1000));
  const safeOffset = Math.max(0, Math.trunc(offset));
  const recurrenceFilter = recurrenceFilters[0];

  const selection = queryBuilder(provider)
    .selectFrom("records")
    .select(["id", "data", "created_by", "created_at", "updated_at"])
    .select(projection ?? [])
    .where(sql<boolean>`${scoped}`)
    .orderBy(order);

  if (recurrenceFilter) {
    // Pagination must happen after recurrence expansion. Fetch the SQL-filtered
    // candidate set once so a large offset never turns into repeated database
    // page crawling and records with no occurrence cannot consume a page.
    const rows = await queryRows<QueryRow>(prisma, provider, selection);
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
        : [
            serializedQueryRecord(
              candidate.row,
              candidate.data,
              occurrences,
              grants
                ? grantFieldFilter(matchingGrants(grants, candidate.row))
                : fieldFilter,
            ),
          ];
    });

    return {
      records: matching.slice(safeOffset, safeOffset + safeLimit),
      total: matching.length,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  const [counts, rows] = await Promise.all([
    queryRows<{ count: bigint | number }>(
      prisma,
      provider,
      sql`SELECT COUNT(*) AS count FROM records WHERE ${scoped}`,
    ),
    queryRows<QueryRow>(
      prisma,
      provider,
      selection.limit(safeLimit).offset(safeOffset),
    ),
  ]);

  return {
    records: rows.map((row) =>
      serializedQueryRecord(
        row,
        queryRecordData(row),
        undefined,
        grants ? grantFieldFilter(matchingGrants(grants, row)) : fieldFilter,
      ),
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
  fieldFilter?: ResolvedFieldFilter | null,
  grants?: RecordGrants,
  principal?: Principal,
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
    fieldFilter,
    grants,
    principal,
  );
  return result.total;
}

export async function aggregateRecords(
  prisma: PrismaClient,
  orgId: string,
  collectionName: string,
  request: AggregateRequest,
  rowFilter?: Where | null,
  fieldFilter?: ResolvedFieldFilter | null,
  grants?: RecordGrants,
  principal?: Principal,
) {
  const provider = queryProvider(prisma);
  const collection = await getCollection(prisma, orgId, collectionName);
  const relations = await relationshipPredicates(
    prisma,
    provider,
    orgId,
    schemaFromCollection(collection),
    request.where,
    principal,
  );
  const referenced = new Set<string>();
  if (grants) {
    compileAggregate(
      request,
      schemaFromCollection(collection),
      provider,
      orgId,
      collection.id,
      {
        relationshipPredicates: relations,
        isFieldAllowed: (field) => {
          referenced.add(field);
          return true;
        },
      },
    );
    rowFilter = queryGrantWhere(grants, referenced);
  }
  const compiled = compileAggregate(
    request,
    schemaFromCollection(collection),
    provider,
    orgId,
    collection.id,
    {
      relationshipPredicates: relations,
      extraWhere: rowFilter,
      isFieldAllowed: (field) =>
        grants ? true : isFieldReadable(field, fieldFilter),
    },
  );
  rejectDeferredFilters(compiled.postFilters);
  const rows = await queryRows<Record<string, unknown>>(
    prisma,
    provider,
    compiled.expression,
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

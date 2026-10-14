import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  InvalidQueryError,
  PermissionDeniedError,
  recordHistoryQuerySchema,
  type AutomationContext,
  type JsonObject,
  type RecordHistoryItem,
  type RecordHistoryQuery,
  type RecordHistoryResult,
  type Schema,
} from "@lastsaas/shared";
import type { Prisma, PrismaClient, RecordHistory } from "@prisma/client";
import { parseRequest } from "../lib/transport";
import {
  getCollectionInTransaction,
  validateCollectionRecordData,
} from "./collections";
import { filterReadableData } from "./fieldFilters";
import { queryProvider } from "./provider";
import {
  evaluateGrants,
  grantFieldFilter,
  metadataFields,
  resolveRecordGrants,
  type RecordGrants,
} from "./record-grants";
import { compileWhere } from "./query/compile";
import { RECORD_HISTORY_RETENTION_MS } from "./record-history-storage";
import type { DbProvider } from "./query/adapters/types";

interface Snapshot {
  data: JsonObject;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface HistoryGrant {
  grant: RecordGrants[number];
  conditionSchema: Schema;
}

async function projectSnapshot(
  prisma: PrismaClient,
  provider: DbProvider,
  historyGrants: HistoryGrant[],
  schema: Schema,
  recordId: string,
  value: Prisma.JsonValue | null,
): Promise<JsonObject | null | undefined> {
  if (value === null) return null;
  const snapshot = value as unknown as Snapshot;
  // A field name can be reused after its live records have been deleted. Old
  // values must not acquire access through SQL casts to the new field type.
  // Validate only predicate fields so independent grants retain additive access.
  const grants = historyGrants
    .filter(
      ({ conditionSchema }) =>
        validateCollectionRecordData(
          Object.fromEntries(
            Object.keys(conditionSchema).map((field) => [
              field,
              snapshot.data[field],
            ]),
          ),
          conditionSchema,
        ).length === 0,
    )
    .map(({ grant }) => grant);
  const matches = await evaluateGrants(
    prisma,
    grants,
    {
      id: recordId,
      data: snapshot.data,
      createdBy: snapshot.created_by,
      createdAt: new Date(snapshot.created_at),
      updatedAt: new Date(snapshot.updated_at),
    },
    schema,
    provider,
  );
  const allowed = grants.filter((_, i) => matches[i]);
  if (!allowed.length) return undefined;
  return filterReadableData(
    snapshot.data,
    grantFieldFilter(allowed),
  ) as JsonObject;
}

async function visibleEntry(
  prisma: PrismaClient,
  provider: DbProvider,
  grants: HistoryGrant[],
  schema: Schema,
  row: RecordHistory,
): Promise<RecordHistoryItem | null> {
  const before = await projectSnapshot(
    prisma,
    provider,
    grants,
    schema,
    row.recordId,
    row.before,
  );
  const after = await projectSnapshot(
    prisma,
    provider,
    grants,
    schema,
    row.recordId,
    row.after,
  );
  if (before == null && after == null) return null;
  const rawBefore = (row.before as unknown as Snapshot | null)?.data ?? {};
  const rawAfter = (row.after as unknown as Snapshot | null)?.data ?? {};
  const changes: RecordHistoryItem["changes"] = {};
  for (const field of new Set([
    ...Object.keys(rawBefore),
    ...Object.keys(rawAfter),
  ])) {
    if (
      Object.hasOwn(rawBefore, field) === Object.hasOwn(rawAfter, field) &&
      isDeepStrictEqual(rawBefore[field], rawAfter[field])
    )
      continue;
    const entry: RecordHistoryItem["changes"][string] = {};
    if (before && Object.hasOwn(before, field)) entry.before = before[field]!;
    if (after && Object.hasOwn(after, field)) entry.after = after[field]!;
    if (Object.keys(entry).length)
      Object.defineProperty(changes, field, { value: entry, enumerable: true });
  }
  // An update confined to unreadable fields must not disclose an event or its metadata.
  if (row.operation === "update" && !Object.keys(changes).length) return null;
  return {
    id: row.id,
    record_id: row.recordId,
    operation: row.operation as RecordHistoryItem["operation"],
    actor_id: row.actorId,
    change_set_id: row.changeSetId,
    created_at: row.createdAt.toISOString(),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    changes,
  };
}

/** History is authorized against saved versions using today's ordinary record grants. */
export async function queryRecordHistory(
  prisma: PrismaClient,
  context: AutomationContext,
  collectionName: string,
  input: RecordHistoryQuery = {},
  now = new Date(),
): Promise<RecordHistoryResult> {
  const query = parseRequest(recordHistoryQuerySchema, input);
  const membership = await prisma.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: context.orgId,
        userId: context.userId,
      },
    },
    select: { id: true },
  });
  if (!membership) throw new PermissionDeniedError();
  const collection = await getCollectionInTransaction(
    prisma,
    context.orgId,
    collectionName,
  );
  const schema = collection.schema as Schema;
  const grants = await resolveRecordGrants(
    prisma,
    context,
    collection.id,
    `/collections/${collectionName}`,
    "read",
  );
  if (!grants.length) throw new PermissionDeniedError();
  const provider = queryProvider(prisma);
  const historyGrants = grants.map((grant) => {
    const conditionSchema: Schema = {};
    compileWhere(grant.where, schema, provider, {
      isFieldAllowed: (field) => {
        if (!metadataFields.has(field)) conditionSchema[field] = schema[field]!;
        return true;
      },
    });
    return { grant, conditionSchema };
  });
  const cutoff = new Date(now.getTime() - RECORD_HISTORY_RETENTION_MS);
  const where: Prisma.RecordHistoryWhereInput = {
    orgId: context.orgId,
    collectionId: collection.id,
    ...(query.record_id ? { recordId: query.record_id } : {}),
    ...(query.change_set_id ? { changeSetId: query.change_set_id } : {}),
    createdAt: {
      gt: cutoff,
      lte: now,
      ...(query.since ? { gte: new Date(query.since) } : {}),
      ...(query.until ? { lt: new Date(query.until) } : {}),
    },
  };
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        context.orgId,
        context.userId,
        collection.id,
        query.record_id ?? null,
        query.change_set_id ?? null,
        query.since ?? null,
        query.until ?? null,
      ]),
    )
    .digest("hex");
  let position: number | undefined;
  if (query.cursor) {
    let id: string;
    try {
      const cursor = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      );
      if (cursor.scope !== scope || typeof cursor.id !== "string")
        throw new Error();
      id = cursor.id;
    } catch {
      throw new InvalidQueryError("Invalid history cursor");
    }
    const anchor = await prisma.recordHistory.findFirst({
      where: { ...where, id },
    });
    if (
      !anchor ||
      !(await visibleEntry(prisma, provider, historyGrants, schema, anchor))
    )
      throw new InvalidQueryError("Invalid history cursor");
    position = anchor.position;
  }
  const items: RecordHistoryItem[] = [];
  while (true) {
    const rows = await prisma.recordHistory.findMany({
      where: {
        ...where,
        ...(position === undefined ? {} : { position: { lt: position } }),
      },
      orderBy: { position: "desc" },
      take: 100,
    });
    for (const row of rows) {
      position = row.position;
      const entry = await visibleEntry(
        prisma,
        provider,
        historyGrants,
        schema,
        row,
      );
      if (!entry) continue;
      if (items.length === query.limit)
        return {
          items,
          next_cursor: Buffer.from(
            JSON.stringify({ id: items.at(-1)!.id, scope }),
          ).toString("base64url"),
        };
      items.push(entry);
    }
    if (rows.length < 100) return { items, next_cursor: null };
  }
}

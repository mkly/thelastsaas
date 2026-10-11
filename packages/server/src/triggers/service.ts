import { parseRequest as parse } from "../lib/transport";
import {
  AUTOMATION_LIMITS,
  AutomationConflictError,
  AutomationNotFoundError,
  FieldPermissionDeniedError,
  PermissionDeniedError,
  SchemaValidationError,
  extractFieldType,
  genId,
  pageRequestSchema,
  queuePayloadSchema,
  triggerCreateSchema,
  triggerIdSchema,
  triggerUpdateSchema,
  type AutomationContext,
  type CollectionTrigger,
  type JsonObject,
  type Schema,
  type TriggerCreate,
  type TriggerService,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { hasPermission } from "../db/casbin";
import { queryProvider } from "../db/provider";
import { compileWhere, substitute } from "../db/query/compile";
import { executeStatement, queryRows, sql } from "../db/query/kysely";
import { resolveRecordGrants } from "../db/record-grants";
import {
  grantProjection,
  grantWhere,
  metadataFields,
  queryGrantWhere,
} from "../db/resource-grants";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";
import {
  auditQueueConfiguration,
  lockQueue,
  queuePageCursor,
  queuePagePosition,
  requireQueueMembership,
} from "../queues/config";
import { authorizeQueueAction } from "../queues/permissions";

async function gate(
  unit: UnitOfWork,
  context: AutomationContext,
  resource: string,
  action: string,
) {
  if (
    !(await hasPermission(
      unit.db,
      context.orgId,
      context.userId,
      resource,
      action,
    ))
  )
    throw new PermissionDeniedError();
}

/** Serialize enabled-count changes on the source collection in either dialect. */
async function lockCollection(unit: UnitOfWork, orgId: string, id: string) {
  if (unit.provider === "postgresql")
    await queryRows(
      unit.db,
      unit.provider,
      sql`SELECT id FROM collections WHERE org_id = ${orgId} AND id = ${id} FOR UPDATE`,
    );
  else
    await executeStatement(
      unit.db,
      unit.provider,
      sql`UPDATE collections SET name = name WHERE org_id = ${orgId} AND id = ${id}`,
    );
}

function compatible(source: string, target: string): boolean {
  if (source === target || target === "json") return true;
  const stringLike = ["string", "text", "date", "datetime", "recurrence"];
  if (["string", "text", "date", "datetime"].includes(target))
    return (
      stringLike.includes(source) ||
      source.startsWith("enum:") ||
      source.startsWith("ref:")
    );
  if (target.startsWith("ref:"))
    return (
      stringLike.includes(source) ||
      source.startsWith("ref:") ||
      source.startsWith("enum:")
    );
  if (["number", "float"].includes(target))
    return ["integer", "number", "float"].includes(source);
  if (source.startsWith("enum:") && target.startsWith("enum:")) {
    const allowed = new Set(
      target
        .slice(5)
        .split(",")
        .map((v) => v.trim()),
    );
    return source
      .slice(5)
      .split(",")
      .every((v) => allowed.has(v.trim()));
  }
  return false;
}

/** Reusable configuration/fire-time validation, always using the creator's
 * current membership and grants. Row-sensitive permissions cannot be decided
 * without a mutation snapshot: the publisher must evaluate readWhere and then
 * project each source field with the matching readGrants, and evaluate the
 * actual mapped payload with writeGrants before enqueueing. */
export async function validateTriggerConfiguration(
  unit: UnitOfWork,
  creator: AutomationContext,
  input: TriggerCreate,
) {
  const parsed = parse(triggerCreateSchema, input);
  await requireQueueMembership(unit.db, creator);
  const collection = await unit.db.collection.findUnique({
    where: { orgId_name: { orgId: creator.orgId, name: parsed.collection } },
  });
  if (!collection) throw new AutomationNotFoundError();
  const queue = await lockQueue(unit, creator, parsed.queue);
  const sourceSchema = collection.schema as Schema;
  const targetSchema = queue.schema as Schema;
  const readGrants = await resolveRecordGrants(
    unit.db,
    creator,
    collection.id,
    `/collections/${collection.name}`,
    "read",
  );
  if (!readGrants.length) throw new PermissionDeniedError();
  await authorizeQueueAction(unit.db, creator, queue.name, "create");
  // Compile all retained row constraints now, so stale/invalid grants fail closed.
  grantProjection(readGrants, sourceSchema, unit.provider);
  const sourceFields = new Set<string>();
  const sourceDataFields = new Set<string>();
  const requireSource = (field: string) => {
    if (!Object.hasOwn(sourceSchema, field))
      throw new SchemaValidationError(["Unknown trigger source field"]);
    sourceFields.add(field);
    sourceDataFields.add(field);
  };
  for (const field of parsed.watched_fields ?? []) requireSource(field);
  const compiled = compileWhere(
    parsed.where && substitute(parsed.where, creator),
    sourceSchema,
    unit.provider,
    {
      isFieldAllowed: (field) => {
        sourceFields.add(field);
        return true;
      },
    },
  );
  if (compiled.postFilters.length)
    throw new SchemaValidationError([
      "Deferred recurrence predicates are not supported by triggers",
    ]);

  const literals: JsonObject = {};
  for (const [target, mapping] of Object.entries(parsed.mapping)) {
    if (!Object.hasOwn(targetSchema, target))
      throw new SchemaValidationError(["Unknown trigger destination field"]);
    const targetType = extractFieldType(targetSchema[target]!)!;
    if (mapping.kind === "literal") {
      literals[target] = mapping.value;
    } else {
      let sourceType: string;
      if (mapping.kind === "before" || mapping.kind === "after") {
        requireSource(mapping.field);
        sourceType = extractFieldType(sourceSchema[mapping.field]!)!;
      } else if (mapping.key === "event") {
        sourceType = `enum:${parsed.events.join(",")}`;
      } else {
        sourceType = mapping.key === "occurredAt" ? "datetime" : "string";
      }
      if (!compatible(sourceType, targetType))
        throw new SchemaValidationError(["Incompatible trigger mapping types"]);
    }
  }
  // The frozen schema grammar has no required modifier; omitted/null fields
  // remain allowed. Literal types and byte bounds still use enqueue validation.
  parse(queuePayloadSchema(targetSchema), literals);
  const deniedRead = [...sourceFields].filter(
    (field) =>
      (sourceDataFields.has(field) || !metadataFields.has(field)) &&
      !readGrants.some(
        (g) => g.readable === undefined || g.readable.includes(field),
      ),
  );
  if (deniedRead.length) throw new FieldPermissionDeniedError(deniedRead);
  return {
    collection,
    queue,
    readGrants,
    sourceFields,
    sourceDataFields,
    readWhere: {
      and: [
        queryGrantWhere(readGrants, sourceFields),
        ...[...sourceDataFields].map((field) =>
          grantWhere(
            readGrants.filter(
              (g) => g.readable === undefined || g.readable.includes(field),
            ),
          ),
        ),
      ],
    },
  };
}

const include = {
  collection: { select: { name: true } },
  queue: { select: { name: true } },
} as const;
type StoredTrigger = Prisma.CollectionTriggerGetPayload<{
  include: typeof include;
}>;

function serialize(row: StoredTrigger): CollectionTrigger {
  return {
    id: row.id,
    organization_id: row.orgId,
    created_by: row.createdBy,
    collection_id: row.collectionId,
    queue_id: row.queueId,
    collection: row.collection.name,
    queue: row.queue.name,
    events: row.events as CollectionTrigger["events"],
    watched_fields: row.watchedFields as CollectionTrigger["watched_fields"],
    where: row.where as CollectionTrigger["where"],
    mapping: row.mapping as CollectionTrigger["mapping"],
    status: row.status as CollectionTrigger["status"],
    pause_reason: row.pauseReason,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function definition(row: StoredTrigger): TriggerCreate {
  return {
    collection: row.collection.name,
    queue: row.queue.name,
    events: row.events as TriggerCreate["events"],
    ...(row.watchedFields === null
      ? {}
      : { watched_fields: row.watchedFields as string[] }),
    ...(row.where === null
      ? {}
      : { where: row.where as TriggerCreate["where"] }),
    mapping: row.mapping as TriggerCreate["mapping"],
    enabled: row.status === "active",
  };
}

async function find(unit: UnitOfWork, context: AutomationContext, id: string) {
  parse(triggerIdSchema, id);
  await requireQueueMembership(unit.db, context);
  const row = await unit.db.collectionTrigger.findFirst({
    where: { orgId: context.orgId, id },
    include,
  });
  if (!row) throw new AutomationNotFoundError();
  return row;
}

async function lockTrigger(unit: UnitOfWork, orgId: string, id: string) {
  if (unit.provider === "postgresql")
    await queryRows(
      unit.db,
      unit.provider,
      sql`SELECT id FROM collection_triggers WHERE org_id = ${orgId} AND id = ${id} FOR UPDATE`,
    );
  else
    await executeStatement(
      unit.db,
      unit.provider,
      sql`UPDATE collection_triggers SET status = status WHERE org_id = ${orgId} AND id = ${id}`,
    );
}

async function limitEnabled(
  unit: UnitOfWork,
  orgId: string,
  collectionId: string,
  enabled: boolean,
  exclude?: string,
) {
  if (
    enabled &&
    (await unit.db.collectionTrigger.count({
      where: {
        orgId,
        collectionId,
        status: "active",
        ...(exclude ? { id: { not: exclude } } : {}),
      },
    })) >= AUTOMATION_LIMITS.triggersPerCollection
  )
    throw new AutomationConflictError("Collection has 25 enabled triggers");
}

function storage(input: TriggerCreate, collectionId: string, queueId: string) {
  return {
    collectionId,
    queueId,
    events: input.events as Prisma.InputJsonArray,
    watchedFields: input.watched_fields ?? Prisma.DbNull,
    where:
      input.where === undefined
        ? Prisma.DbNull
        : (input.where as Prisma.InputJsonObject),
    mapping: input.mapping as Prisma.InputJsonObject,
    status: input.enabled ? "active" : "paused",
    pauseReason: input.enabled ? null : "Paused by user",
  };
}

/** CRUD only; the record-mutation publisher composes separately into the UoW. */
export function createTriggerService(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): TriggerService {
  const source = { prisma, provider };
  return {
    async create(context, input) {
      const parsed = parse(triggerCreateSchema, input);
      return withUnitOfWork(source, async (unit) => {
        await requireQueueMembership(unit.db, context);
        await gate(unit, context, "/triggers", "write");
        const collection = await unit.db.collection.findUnique({
          where: {
            orgId_name: { orgId: context.orgId, name: parsed.collection },
          },
        });
        if (!collection) throw new AutomationNotFoundError();
        await lockCollection(unit, context.orgId, collection.id);
        const validated = await validateTriggerConfiguration(
          unit,
          context,
          parsed,
        );
        await limitEnabled(unit, context.orgId, collection.id, parsed.enabled);
        const row = await unit.db.collectionTrigger.create({
          data: {
            id: genId(),
            orgId: context.orgId,
            createdBy: context.userId,
            ...storage(parsed, validated.collection.id, validated.queue.id),
          },
          include,
        });
        await auditQueueConfiguration(
          unit.db,
          context,
          "create_trigger",
          row.id,
          "trigger",
        );
        return serialize(row);
      });
    },
    async list(context, input) {
      const { limit, cursor } = parse(pageRequestSchema, input);
      const scope = JSON.stringify(["triggers:v1", context.orgId]);
      const position = queuePagePosition(cursor, scope);
      return withUnitOfWork(source, async (unit) => {
        await requireQueueMembership(unit.db, context);
        const candidates = await unit.db.collectionTrigger.findMany({
          where: { orgId: context.orgId, ...position },
          include,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit + 1,
        });
        const scanned = candidates.slice(0, limit);
        const items: CollectionTrigger[] = [];
        for (const row of scanned)
          if (
            await hasPermission(
              unit.db,
              context.orgId,
              context.userId,
              `/triggers/${row.id}`,
              "read",
            )
          )
            items.push(serialize(row));
        return {
          items,
          next_cursor:
            candidates.length > limit
              ? queuePageCursor(scanned[scanned.length - 1]!, scope)
              : null,
        };
      });
    },
    async show(context, id) {
      return withUnitOfWork(source, async (unit) => {
        const row = await find(unit, context, id);
        await gate(unit, context, `/triggers/${id}`, "read");
        return serialize(row);
      });
    },
    async update(context, id, input) {
      parse(triggerIdSchema, id);
      const patch = parse(triggerUpdateSchema, input);
      return withUnitOfWork(source, async (unit) => {
        await requireQueueMembership(unit.db, context);
        await lockTrigger(unit, context.orgId, id);
        const row = await find(unit, context, id);
        await gate(unit, context, `/triggers/${id}`, "update");
        const parsed = parse(triggerCreateSchema, {
          ...definition(row),
          ...patch,
        });
        const collection = await unit.db.collection.findUnique({
          where: {
            orgId_name: { orgId: context.orgId, name: parsed.collection },
          },
        });
        if (!collection) throw new AutomationNotFoundError();
        // Stable order for concurrent moves between collections.
        for (const collectionId of [
          ...new Set([row.collectionId, collection.id]),
        ].sort())
          await lockCollection(unit, context.orgId, collectionId);
        const creator = await unit.db.user.findUnique({
          where: { id: row.createdBy },
          select: { email: true },
        });
        if (!creator) throw new AutomationNotFoundError();
        const validated = await validateTriggerConfiguration(
          unit,
          {
            orgId: row.orgId,
            userId: row.createdBy,
            userEmail: creator.email,
          },
          parsed,
        );
        await limitEnabled(
          unit,
          context.orgId,
          collection.id,
          parsed.enabled,
          row.id,
        );
        const updated = await unit.db.collectionTrigger.update({
          where: { id },
          data: {
            ...storage(parsed, validated.collection.id, validated.queue.id),
            // Edits to an already paused trigger keep its visible reason, such
            // as an authorization pause recorded by the publisher.
            ...(row.status === "paused" && !parsed.enabled
              ? { pauseReason: row.pauseReason }
              : {}),
          },
          include,
        });
        await auditQueueConfiguration(
          unit.db,
          context,
          "update_trigger",
          id,
          "trigger",
        );
        return serialize(updated);
      });
    },
    async delete(context, id) {
      await withUnitOfWork(source, async (unit) => {
        const row = await find(unit, context, id);
        await gate(unit, context, `/triggers/${id}`, "delete");
        await unit.db.collectionTrigger.delete({ where: { id: row.id } });
        await auditQueueConfiguration(
          unit.db,
          context,
          "delete_trigger",
          id,
          "trigger",
        );
      });
    },
  };
}

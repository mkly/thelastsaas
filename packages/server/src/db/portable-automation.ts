import {
  genId,
  SchemaValidationError,
  type ExportData,
  type ImportResult,
  type Schema,
  type TriggerCreate,
} from "@lastsaas/shared";
import { Prisma } from "@prisma/client";
import { scheduleTimingState } from "../schedules/service";
import { compileWhere } from "./query/compile";
import type { DbProvider } from "./query/adapters/types";

type Db = Prisma.TransactionClient;
function json(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}
function fail(message: string): never {
  throw new SchemaValidationError([message]);
}

export async function exportAutomation(db: Db, orgId: string) {
  const queues = await db.queue.findMany({
    where: { orgId },
    orderBy: { id: "asc" },
  });
  const queueIds = queues.map((q) => q.id);
  const [subscriptions, schedules, triggers] = await Promise.all([
    db.queueSubscription.findMany({
      where: { queueId: { in: queueIds } },
      orderBy: { id: "asc" },
    }),
    db.queueSchedule.findMany({
      where: { orgId, queueId: { in: queueIds } },
      orderBy: { id: "asc" },
    }),
    db.collectionTrigger.findMany({
      where: { orgId, queueId: { in: queueIds } },
      orderBy: { id: "asc" },
      include: { collection: true },
    }),
  ]);
  const timestamps = (v: { createdAt: Date; updatedAt: Date }) => ({
    created_at: v.createdAt.toISOString(),
    updated_at: v.updatedAt.toISOString(),
  });
  return {
    queues: queues.map((q) => ({
      id: q.id,
      name: q.name,
      schema: q.schema as Schema,
      schema_version: q.schemaVersion,
      enabled: q.enabled,
      ...timestamps(q),
    })),
    queue_subscriptions: subscriptions.map((s) => ({
      id: s.id,
      queue_id: s.queueId,
      name: s.name,
      enabled: s.enabled,
      max_attempts: s.maxAttempts,
      retry_delay_seconds: s.retryDelaySeconds,
      lease_seconds: s.leaseSeconds,
      retention_days: s.retentionDays,
      ...timestamps(s),
    })),
    queue_schedules: schedules.map((s) => ({
      id: s.id,
      queue_id: s.queueId,
      created_by: s.createdBy,
      payload: s.payload as NonNullable<
        ExportData["queue_schedules"]
      >[number]["payload"],
      timing:
        s.recurrence === null
          ? { kind: "once" as const, at: s.deliverAt!.toISOString() }
          : { kind: "recurring" as const, recurrence: s.recurrence },
      status: s.status as "active" | "paused" | "completed",
      pause_reason: s.pauseReason,
      ...timestamps(s),
    })),
    collection_triggers: triggers.map((t) => ({
      id: t.id,
      queue_id: t.queueId,
      created_by: t.createdBy,
      configuration: {
        queue: queues.find((q) => q.id === t.queueId)!.name,
        enabled: t.status === "active",
        collection: t.collection.name,
        events: t.events as TriggerCreate["events"],
        ...(t.watchedFields === null
          ? {}
          : { watched_fields: t.watchedFields as string[] }),
        ...(t.where === null
          ? {}
          : { where: t.where as TriggerCreate["where"] }),
        mapping: t.mapping as TriggerCreate["mapping"],
      },
      status: t.status as "active" | "paused",
      pause_reason: t.pauseReason,
      ...timestamps(t),
    })),
  } satisfies Partial<ExportData>;
}

export function validateAutomation(data: ExportData, provider: DbProvider) {
  const unique = <T>(items: readonly T[], key: (v: T) => string) => {
    const keys = items.map(key);
    if (new Set(keys).size !== keys.length) fail("Duplicate backup identity");
  };
  for (const rows of [
    data.queues,
    data.queue_subscriptions,
    data.queue_schedules,
    data.collection_triggers,
  ])
    unique<{ id: string }>(rows ?? [], (v) => v.id);
  const queues = new Map((data.queues ?? []).map((q) => [q.id, q]));
  const subscriptions = new Map(
    (data.queue_subscriptions ?? []).map((s) => [s.id, s]),
  );
  const schedules = new Map((data.queue_schedules ?? []).map((s) => [s.id, s]));
  const collections = new Map(data.collections.map((c) => [c.name, c.schema]));
  const queue = (id: string) =>
    queues.get(id) ?? fail("Missing backup queue reference");
  unique(data.queues ?? [], (q) => q.name);
  unique(data.queue_subscriptions ?? [], (s) =>
    JSON.stringify([s.queue_id, s.name]),
  );
  for (const s of subscriptions.values()) queue(s.queue_id);
  for (const s of schedules.values()) {
    queue(s.queue_id);
    scheduleTimingState(s.timing);
    // A producer may have been paused because its destination schema changed;
    // retain its payload for explicit repair rather than activating it.
  }
  for (const t of data.collection_triggers ?? []) {
    if (queue(t.queue_id).name !== t.configuration.queue)
      fail("Invalid backup trigger queue name");
    const schema = collections.get(t.configuration.collection);
    if (!schema) fail("Missing backup trigger collection");
    const compiled = compileWhere(t.configuration.where, schema, provider);
    if (compiled.postFilters.length) fail("Invalid deferred trigger predicate");
  }
}

export async function importAutomation(
  db: Db,
  orgId: string,
  data: ExportData,
  collectionIds: Map<string, string>,
) {
  const ids = new Map<string, Map<string, string>>();
  const allocate = async (
    kind: string,
    old: string,
    exists: (id: string) => Promise<unknown>,
  ) => {
    const value = (await exists(old)) ? genId() : old;
    const map = ids.get(kind) ?? new Map<string, string>();
    map.set(old, value);
    ids.set(kind, map);
    return value;
  };
  const ref = (kind: string, old: string) =>
    ids.get(kind)?.get(old) ?? fail("Missing imported reference");
  const dates = (v: { created_at: string; updated_at: string }) => ({
    createdAt: new Date(v.created_at),
    updatedAt: new Date(v.updated_at),
  });
  const creator = async (id: string) => {
    if (!(await db.user.findUnique({ where: { id }, select: { id: true } })))
      fail("Backup producer user is unavailable");
    return id;
  };
  for (const q of data.queues ?? []) {
    if (
      await db.queue.findUnique({
        where: { orgId_name: { orgId, name: q.name } },
      })
    )
      fail("Backup queue name already exists");
    await db.queue.create({
      data: {
        id: await allocate("queue", q.id, (id) =>
          db.queue.findUnique({ where: { id }, select: { id: true } }),
        ),
        orgId,
        name: q.name,
        schema: json(q.schema),
        schemaVersion: q.schema_version,
        enabled: q.enabled,
        ...dates(q),
      },
    });
  }
  for (const s of data.queue_subscriptions ?? [])
    await db.queueSubscription.create({
      data: {
        id: await allocate("subscription", s.id, (id) =>
          db.queueSubscription.findUnique({
            where: { id },
            select: { id: true },
          }),
        ),
        queueId: ref("queue", s.queue_id),
        name: s.name,
        enabled: s.enabled,
        maxAttempts: s.max_attempts,
        retryDelaySeconds: s.retry_delay_seconds,
        leaseSeconds: s.lease_seconds,
        retentionDays: s.retention_days,
        ...dates(s),
      },
    });
  for (const s of data.queue_schedules ?? [])
    await db.queueSchedule.create({
      data: {
        id: await allocate("schedule", s.id, (id) =>
          db.queueSchedule.findUnique({ where: { id }, select: { id: true } }),
        ),
        orgId,
        queueId: ref("queue", s.queue_id),
        createdBy: await creator(s.created_by),
        payload: json(s.payload),
        ...scheduleTimingState(s.timing),
        status: "paused",
        pauseReason: "Imported; explicit resume required",
        ...dates(s),
      },
    });
  for (const t of data.collection_triggers ?? [])
    await db.collectionTrigger.create({
      data: {
        id: await allocate("trigger", t.id, (id) =>
          db.collectionTrigger.findUnique({
            where: { id },
            select: { id: true },
          }),
        ),
        orgId,
        createdBy: await creator(t.created_by),
        queueId: ref("queue", t.queue_id),
        collectionId: collectionIds.get(t.configuration.collection)!,
        events: t.configuration.events,
        watchedFields: t.configuration.watched_fields ?? Prisma.DbNull,
        where: t.configuration.where
          ? json(t.configuration.where)
          : Prisma.DbNull,
        mapping: json(t.configuration.mapping),
        status: "paused",
        pauseReason: "Imported; explicit resume required",
        ...dates(t),
      },
    });
  const counts = {
    imported_queues: data.queues?.length ?? 0,
    imported_queue_subscriptions: data.queue_subscriptions?.length ?? 0,
    imported_queue_schedules: data.queue_schedules?.length ?? 0,
    imported_collection_triggers: data.collection_triggers?.length ?? 0,
  } satisfies Partial<ImportResult>;
  return {
    counts,
    resourceIds: new Map<string, string>([
      ...[...(ids.get("schedule") ?? [])].map(
        ([old, id]) => [`/schedules/${old}`, `/schedules/${id}`] as const,
      ),
      ...[...(ids.get("trigger") ?? [])].map(
        ([old, id]) => [`/triggers/${old}`, `/triggers/${id}`] as const,
      ),
    ]),
  };
}

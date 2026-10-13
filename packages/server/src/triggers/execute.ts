import { createHash } from "node:crypto";
import {
  AUTOMATION_LIMITS,
  AutomationNotFoundError,
  FieldPermissionDeniedError,
  InvalidQueryError,
  PermissionDeniedError,
  SchemaValidationError,
  genId,
  queuePayloadSchema,
  type JsonObject,
  type RecordMutationEvent,
  type Schema,
  type TriggerCreate,
} from "@lastsaas/shared";
import type { MutationSnapshots } from "../db/record-mutations";
import { substitute } from "../db/query/compile";
import { executeStatement, queryRows, sql } from "../db/query/kysely";
import {
  evaluateGrants,
  metadataFields,
  type GrantRecord,
  type ResourceGrants,
} from "../db/resource-grants";
import type { UnitOfWork } from "../db/unit-of-work";
import { enqueueQueueInTransaction } from "../queues/enqueue";
import { validateTriggerConfiguration } from "./service";

async function matches(
  unit: UnitOfWork,
  row: GrantRecord,
  schema: Schema,
  grants: ResourceGrants,
) {
  const result = await evaluateGrants(
    unit.db,
    grants,
    row,
    schema,
    unit.provider,
  );
  return grants.filter((_, i) => result[i]);
}

function readable(grants: ResourceGrants, fields: Iterable<string>) {
  return (
    grants.length > 0 &&
    [...fields].every((field) =>
      grants.some(
        (g) => g.readable === undefined || g.readable.includes(field),
      ),
    )
  );
}

/** Only configuration/authority errors pause. Driver and persistence failures
 * propagate, rolling back the source mutation, messages and transactional audit. */
function invalidRule(error: unknown) {
  return (
    error instanceof AutomationNotFoundError ||
    error instanceof PermissionDeniedError ||
    error instanceof FieldPermissionDeniedError ||
    error instanceof InvalidQueryError ||
    error instanceof SchemaValidationError
  );
}

/** All callers supply the exact persisted before/after rows, even after DELETE.
 * The optional UoW callback is additive; it cannot bypass this publisher. */
export async function executeRecordTriggers(
  unit: UnitOfWork,
  orgId: string,
  event: RecordMutationEvent,
  snapshots: MutationSnapshots,
): Promise<{ enqueued: number; paused: number }> {
  const candidates = await unit.db.collectionTrigger.findMany({
    where: { orgId, collection: { name: event.collection }, status: "active" },
    select: { id: true },
    orderBy: { id: "asc" },
    take: AUTOMATION_LIMITS.triggersPerCollection,
  });
  let enqueued = 0;
  let paused = 0;
  rules: for (const candidate of candidates) {
    // Re-read after locking so concurrent pause/edit/delete cannot publish a stale rule.
    if (unit.provider === "postgresql")
      await queryRows(
        unit.db,
        unit.provider,
        sql`SELECT id FROM collection_triggers WHERE org_id = ${orgId} AND id = ${candidate.id} FOR UPDATE`,
      );
    else
      await executeStatement(
        unit.db,
        unit.provider,
        sql`UPDATE collection_triggers SET status = status WHERE org_id = ${orgId} AND id = ${candidate.id}`,
      );
    const row = await unit.db.collectionTrigger.findFirst({
      where: {
        id: candidate.id,
        orgId,
        status: "active",
        collection: { name: event.collection },
      },
      include: {
        collection: true,
        queue: true,
        creator: { select: { email: true } },
      },
    });
    if (!row) continue;
    const definition: TriggerCreate = {
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
      enabled: true,
    };
    const creator = {
      orgId,
      userId: row.createdBy,
      userEmail: row.creator.email,
    };
    let payload: JsonObject;
    try {
      const validated = await validateTriggerConfiguration(
        unit,
        creator,
        definition,
      );
      if (!definition.events.includes(event.event)) continue;
      if (
        event.event === "update" &&
        !event.changed_fields.some(
          (field) =>
            !definition.watched_fields ||
            definition.watched_fields.includes(field),
        )
      )
        continue;
      const source =
        event.event === "delete" ? snapshots.before : snapshots.after;
      if (!source)
        throw new SchemaValidationError(["Missing trigger snapshot"]);
      const schema = validated.collection.schema as Schema;
      const grants = await matches(unit, source, schema, validated.readGrants);
      // Row-ineligible mutations are skipped, without disabling a rule that
      // still has authority on other rows. Predicate fields also require access.
      if (
        !readable(
          grants,
          [...validated.sourceFields].filter(
            (field) =>
              validated.sourceDataFields.has(field) ||
              !metadataFields.has(field),
          ),
        )
      )
        continue;
      if (
        !(
          await matches(unit, source, schema, [
            {
              where: definition.where && substitute(definition.where, creator),
              checkAfter: true,
            },
          ])
        ).length
      )
        continue;

      const beforeFields: string[] = [];
      const afterFields: string[] = [];
      for (const mapping of Object.values(definition.mapping)) {
        if (mapping.kind === "before") beforeFields.push(mapping.field);
        if (mapping.kind === "after") afterFields.push(mapping.field);
      }
      for (const [snapshot, fields] of [
        [snapshots.before, beforeFields],
        [snapshots.after, afterFields],
      ] as const) {
        if (
          fields.length &&
          (!snapshot ||
            !readable(
              await matches(unit, snapshot, schema, validated.readGrants),
              fields,
            ))
        )
          // An earlier value never inherits the later row's field authority.
          continue rules;
      }
      payload = Object.fromEntries(
        Object.entries(definition.mapping).map(([target, mapping]) => {
          if (mapping.kind === "literal") return [target, mapping.value];
          if (mapping.kind === "before" || mapping.kind === "after")
            return [target, event[mapping.kind]?.[mapping.field] ?? null];
          const metadata = {
            recordId: event.record_id,
            collectionName: event.collection,
            event: event.event,
            occurredAt: event.occurred_at,
          };
          return [target, metadata[mapping.key]];
        }),
      );
      if (
        !queuePayloadSchema(validated.queue.schema as Schema).safeParse(payload)
          .success
      )
        throw new SchemaValidationError(["Invalid trigger payload"]);
      if (!validated.queue.enabled)
        throw new SchemaValidationError(["Trigger destination unavailable"]);
    } catch (error) {
      if (!invalidRule(error)) throw error;
      const reason =
        "Trigger configuration or creator authority is no longer valid";
      await unit.db.collectionTrigger.update({
        where: { id: row.id },
        data: { status: "paused", pauseReason: reason },
      });
      await unit.db.auditLog.create({
        data: {
          id: genId(),
          orgId,
          userId: row.createdBy,
          action: "pause_trigger",
          resourceType: "trigger",
          resourceId: row.id,
          details: { reason },
        },
      });
      paused++;
      continue;
    }
    // Enqueue outside the pause catch: even domain-looking persistence errors
    // must abort the source transaction. Queue locking serializes deduplication.
    const idempotencyKey =
      "trigger:" +
      createHash("sha256")
        .update(JSON.stringify([row.id, event.mutation_id]))
        .digest("hex");
    // Passing the existing UoW avoids another connection or nested transaction.
    await enqueueQueueInTransaction(creator, unit, row.queue.name, {
      entries: [{ payload, idempotency_key: idempotencyKey }],
    });
    enqueued++;
  }
  return { enqueued, paused };
}

import { parseRequest as parseQueueRequest } from "../lib/transport";
import { unitJobs, workQueue } from "../jobs";
import {
  AutomationConflictError,
  AutomationNotFoundError,
  PermissionDeniedError,
  SchemaValidationError,
  genId,
  pageRequestSchema,
  queueCreateSchema,
  queueUpdateSchema,
  type AutomationContext,
  type Queue,
  type QueueService,
  type Schema,
} from "@lastsaas/shared";
import {
  Prisma,
  type PrismaClient,
  type Queue as QueueRow,
} from "@prisma/client";
import { z } from "zod";
import { hasPermission } from "../db/casbin";
import { invalidateMetadata, policyCacheKey } from "../db/cache";
import { queryProvider } from "../db/provider";
import { executeStatement, queryRows, sql } from "../db/query/kysely";
import { resolveResourceGrants } from "../db/resource-grants";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";
import { authorizeQueue } from "./permissions";

export async function requireQueueMembership(
  db: Prisma.TransactionClient,
  context: AutomationContext,
) {
  const member = await db.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: context.orgId,
        userId: context.userId,
      },
    },
    select: { id: true },
  });
  if (!member) throw new AutomationNotFoundError();
}

export async function requireQueueGate(
  db: Prisma.TransactionClient,
  context: AutomationContext,
  resource: string,
  action: "write" | "manage" | "delete",
) {
  if (
    !(await hasPermission(db, context.orgId, context.userId, resource, action))
  )
    throw new PermissionDeniedError();
}

/** Serialize configuration writes with producers using the same queue lock.
 * SQLite's no-op write acquires its writer lock without changing timestamps. */
export async function lockQueue(
  unit: UnitOfWork,
  context: AutomationContext,
  name: string,
) {
  const row = await authorizeQueue(unit.db, context, name);
  await lockQueueRow(unit, row.id);
  // A competing deletion/configuration change may have committed before the lock.
  const current = await authorizeQueue(unit.db, context, name);
  if (current.id !== row.id)
    throw new AutomationConflictError("Queue changed during configuration");
  return current;
}

/** Serialize queue configuration and publication. */
export async function lockQueueRow(unit: UnitOfWork, id: string) {
  if (unit.provider === "postgresql")
    await queryRows(
      unit.db,
      unit.provider,
      sql`SELECT id FROM queues WHERE id = ${id} FOR UPDATE`,
    );
  else
    await executeStatement(
      unit.db,
      unit.provider,
      sql`UPDATE queues SET schema_version = schema_version WHERE id = ${id}`,
    );
}

function serializeQueue(row: QueueRow): Queue {
  return {
    id: row.id,
    organization_id: row.orgId,
    name: row.name,
    schema: row.schema as Schema,
    schema_version: row.schemaVersion,
    enabled: row.enabled,
    max_attempts: row.maxAttempts,
    retry_delay_seconds: row.retryDelaySeconds,
    lease_seconds: row.leaseSeconds,
    retention_days: row.retentionDays,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function auditQueueConfiguration(
  db: Prisma.TransactionClient,
  context: AutomationContext,
  action: string,
  id: string,
  resourceType = "queue",
) {
  await db.auditLog.create({
    data: {
      id: genId(),
      orgId: context.orgId,
      userId: context.userId,
      action,
      resourceType,
      resourceId: id,
    },
  });
}

const cursorSchema = z.strictObject({
  scope: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string().min(1).max(128),
});

export function queuePagePosition(cursor: string | undefined, scope: string) {
  if (!cursor) return {};
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error();
    const position = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (position.scope !== scope) throw new Error();
    const createdAt = new Date(position.createdAt);
    return {
      OR: [
        { createdAt: { gt: createdAt } },
        { createdAt, id: { gt: position.id } },
      ],
    };
  } catch {
    throw new SchemaValidationError(["Invalid queue cursor"]);
  }
}

export function queuePageCursor(
  row: { id: string; createdAt: Date },
  scope: string,
) {
  return Buffer.from(
    JSON.stringify({
      scope,
      createdAt: row.createdAt.toISOString(),
      id: row.id,
    }),
  ).toString("base64url");
}

export function queueNameConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  )
    throw new AutomationConflictError("Resource name already exists");
  throw error;
}

export type QueueConfigService = Pick<
  QueueService<UnitOfWork>,
  "create" | "list" | "show" | "update" | "delete"
>;

/** Transport-independent configuration operations; responses contain no entries. */
export function createQueueConfigService(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): QueueConfigService {
  const source = { prisma, provider };
  return {
    async create(context, input) {
      const parsed = parseQueueRequest(queueCreateSchema, input);
      try {
        return await withUnitOfWork(source, async ({ db }) => {
          await requireQueueMembership(db, context);
          await requireQueueGate(db, context, "/queues", "write");
          const row = await db.queue.create({
            data: {
              id: genId(),
              orgId: context.orgId,
              name: parsed.name,
              schema: parsed.schema as Prisma.InputJsonObject,
              enabled: parsed.enabled,
              maxAttempts: parsed.max_attempts,
              retryDelaySeconds: parsed.retry_delay_seconds,
              leaseSeconds: parsed.lease_seconds,
              retentionDays: parsed.retention_days,
            },
          });
          await auditQueueConfiguration(db, context, "create_queue", row.id);
          return serializeQueue(row);
        });
      } catch (error) {
        return queueNameConflict(error);
      }
    },
    async list(context, input) {
      const { limit, cursor } = parseQueueRequest(pageRequestSchema, input);
      const scope = JSON.stringify(["queues:v1", context.orgId]);
      const position = queuePagePosition(cursor, scope);
      return withUnitOfWork(source, async ({ db }) => {
        await requireQueueMembership(db, context);
        const candidates = await db.queue.findMany({
          where: { orgId: context.orgId, ...position },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit + 1,
        });
        const scanned = candidates.slice(0, limit);
        const items: Queue[] = [];
        for (const row of scanned)
          if (
            (
              await resolveResourceGrants(
                db,
                context,
                `/queues/${row.name}`,
                "read",
              )
            ).length
          )
            items.push(serializeQueue(row));
        return {
          items,
          next_cursor:
            candidates.length > limit
              ? queuePageCursor(scanned[scanned.length - 1]!, scope)
              : null,
        };
      });
    },
    async show(context, name) {
      return withUnitOfWork(source, async ({ db }) => {
        const row = await authorizeQueue(db, context, name);
        if (
          !(await resolveResourceGrants(db, context, `/queues/${name}`, "read"))
            .length
        )
          throw new PermissionDeniedError();
        return serializeQueue(row);
      });
    },
    async update(context, name, input) {
      const parsed = parseQueueRequest(queueUpdateSchema, input);
      return withUnitOfWork(source, async (unit) => {
        const row = await lockQueue(unit, context, name);
        await requireQueueGate(unit.db, context, `/queues/${name}`, "manage");
        if (
          parsed.schema !== undefined &&
          (await unit.db.queueEntry.count({ where: { queueId: row.id } }))
        )
          throw new AutomationConflictError(
            "Cannot change schema while entries are retained",
          );
        const updated = await unit.db.queue.update({
          where: { id: row.id },
          data: {
            maxAttempts: parsed.max_attempts,
            retryDelaySeconds: parsed.retry_delay_seconds,
            leaseSeconds: parsed.lease_seconds,
            retentionDays: parsed.retention_days,
            ...(parsed.schema !== undefined
              ? {
                  schema: parsed.schema as Prisma.InputJsonObject,
                  schemaVersion: { increment: 1 },
                }
              : {}),
            ...(parsed.enabled !== undefined
              ? { enabled: parsed.enabled }
              : {}),
          },
        });
        await auditQueueConfiguration(unit.db, context, "update_queue", row.id);
        return serializeQueue(updated);
      });
    },
    async delete(context, name) {
      await withUnitOfWork(source, async (unit) => {
        const row = await lockQueue(unit, context, name);
        await requireQueueGate(unit.db, context, `/queues/${name}`, "delete");
        const entries = await unit.db.queueEntry.findMany({
          where: { queueId: row.id },
        });
        for (const entry of entries) {
          const job = await unitJobs(unit).get(workQueue(row.id), entry.id);
          if (
            (await unit.db.jobOutbox.findUnique({ where: { id: entry.id } })) ||
            (job && ["ready", "leased"].includes(job.state))
          )
            throw new AutomationConflictError("Queue has unfinished jobs");
        }
        await unitJobs(unit).deleteQueue(workQueue(row.id));
        await unit.db.queue.delete({ where: { id: row.id } });
        // LIKE treats "_" as a wildcard and is case-insensitive on SQLite, so
        // match the child prefix exactly before deleting.
        const resource = `/queues/${name}`;
        const rules = await unit.db.casbinRule.findMany({
          where: {
            orgId: context.orgId,
            ptype: "p",
            v1: { startsWith: resource },
          },
          select: { id: true, v1: true },
        });
        await unit.db.casbinRule.deleteMany({
          where: {
            id: {
              in: rules
                .filter(
                  ({ v1 }) => v1 === resource || v1?.startsWith(`${resource}/`),
                )
                .map(({ id }) => id),
            },
          },
        });
        await auditQueueConfiguration(unit.db, context, "delete_queue", row.id);
      });
      await invalidateMetadata(prisma, policyCacheKey(context.orgId));
    },
  };
}

export { parseRequest as parseQueueRequest } from "../lib/transport";

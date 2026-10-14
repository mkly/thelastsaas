import stringify from "fast-json-stable-stringify";
import { createHash } from "node:crypto";
import {
  AutomationConflictError,
  AutomationNotFoundError,
  PermissionDeniedError,
  SchemaValidationError,
  genId,
  transactionRequestSchema,
  type AutomationContext,
  type CollectionRecord,
  type Schema,
  type TransactionOperation,
  type TransactionOperationResult,
  type TransactionResult,
  type TransactionService,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getCollectionInTransaction } from "../db/collections";
import { filterReadableData } from "../db/fieldFilters";
import { queryProvider } from "../db/provider";
import { executeStatement, queryRows, sql } from "../db/query/kysely";
import {
  evaluateGrants,
  grantFieldFilter,
  resolveRecordGrants,
} from "../db/record-grants";
import {
  deleteRecordInTransaction,
  insertRecordInTransaction,
  updateRecordInTransaction,
} from "../db/records";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";

const retentionMs = 7 * 24 * 60 * 60 * 1000;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function requireMembership(
  unit: UnitOfWork,
  context: AutomationContext,
  lock: boolean,
) {
  // Serialize keyed calls for this principal before reading the dedup row. Unlike
  // insert-and-catch, this also works in PostgreSQL without an aborted transaction.
  const condition = sql`"organizationId" = ${context.orgId} AND "userId" = ${context.userId}`;
  if (lock) {
    if (unit.provider === "postgresql")
      await queryRows(
        unit.db,
        unit.provider,
        sql`SELECT id FROM member WHERE ${condition} FOR UPDATE`,
      );
    else
      await executeStatement(
        unit.db,
        unit.provider,
        sql`UPDATE member SET role = role WHERE ${condition}`,
      );
  }
  const member = await unit.db.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: context.orgId,
        userId: context.userId,
      },
    },
  });
  if (!member) throw new AutomationNotFoundError();
}

async function recordGrants(
  unit: UnitOfWork,
  context: AutomationContext,
  collectionName: string,
  action: string,
) {
  const collection = await getCollectionInTransaction(
    unit.db,
    context.orgId,
    collectionName,
  );
  const grants = await resolveRecordGrants(
    unit.db,
    context,
    collection.id,
    `/collections/${collectionName}`,
    action,
  );
  if (!grants.length) throw new PermissionDeniedError();
  return { collection, grants };
}

// Full snapshots are internal authorization inputs, separate from saved projected
// responses. Conditions may refer to fields absent from the original response.
type Visibility = CollectionRecord[];

async function replay(
  unit: UnitOfWork,
  context: AutomationContext,
  operations: TransactionOperation[],
  response: TransactionResult,
  visibility: Visibility,
): Promise<TransactionResult> {
  const results: TransactionOperationResult[] = [];
  for (const [index, operation] of operations.entries()) {
    const result = response.results[index]!;
    const snapshot = visibility[index]!;
    const { collection, grants } = await recordGrants(
      unit,
      context,
      operation.collection,
      operation.op === "record.delete" ? "delete" : "read",
    );
    const matches = await evaluateGrants(
      unit.db,
      grants,
      {
        id: snapshot.id,
        data: snapshot.data,
        createdBy: snapshot.created_by,
        createdAt: new Date(snapshot.created_at),
        updatedAt: new Date(snapshot.updated_at),
      },
      collection.schema as Schema,
      unit.provider,
    );
    const allowed = grants.filter((_, i) => matches[i]);
    if (!allowed.length) throw new PermissionDeniedError();
    if (result.op === "record.create" || result.op === "record.update") {
      results.push({
        ...result,
        record: {
          ...result.record,
          data: filterReadableData(
            result.record.data,
            grantFieldFilter(allowed),
          ),
        },
      });
    } else results.push(result);
  }
  return { results };
}

/** Operations, trigger publication, audit and dedup responses share one transaction. */
export function createTransactionService(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): TransactionService {
  return {
    async execute(context, input) {
      const parsed = transactionRequestSchema.safeParse(input);
      if (!parsed.success)
        throw new SchemaValidationError([
          "Invalid transaction request: only record.create, record.update, and record.delete operations",
        ]);
      const { operations, idempotency_key: key } = parsed.data;
      const hash =
        key === undefined
          ? undefined
          : createHash("sha256").update(stringify(operations)).digest("hex");
      // Retry only known rolled-back contention failures, never domain errors.
      for (let attempt = 0; ; attempt++) {
        try {
          return await withUnitOfWork(
            { prisma, provider },
            async (unit) => {
              await requireMembership(unit, context, key !== undefined);
              const now = new Date();
              const scope = {
                orgId: context.orgId,
                principalId: context.userId,
                key: key!,
              };
              if (key !== undefined) {
                await unit.db.transactionRequest.deleteMany({
                  where: { ...scope, expiresAt: { lte: now } },
                });
                const retained = await unit.db.transactionRequest.findUnique({
                  where: { orgId_principalId_key: scope },
                });
                if (retained) {
                  if (retained.requestHash !== hash)
                    throw new AutomationConflictError(
                      "Idempotency key conflicts with request",
                    );
                  return replay(
                    unit,
                    context,
                    operations,
                    retained.response as unknown as TransactionResult,
                    retained.visibility as unknown as Visibility,
                  );
                }
              }
              const results: TransactionOperationResult[] = [];
              const visibility: Visibility = [];
              for (const operation of operations) {
                const action = operation.op.split(".")[1]!;
                const { grants } = await recordGrants(
                  unit,
                  context,
                  operation.collection,
                  action,
                );
                let id: string;
                if (operation.op === "record.delete") {
                  const { snapshot } = await deleteRecordInTransaction(
                    unit,
                    context.orgId,
                    operation.collection,
                    operation.id,
                    undefined,
                    grants,
                    context.userId,
                  );
                  id = operation.id;
                  results.push({ op: operation.op, id });
                  // Deleted records need the pre-delete timestamps for row grants.
                  if (key !== undefined) visibility.push(snapshot);
                } else {
                  const { record } =
                    operation.op === "record.create"
                      ? await insertRecordInTransaction(
                          unit,
                          context.orgId,
                          operation.collection,
                          operation.data,
                          context.userId,
                          undefined,
                          grants,
                        )
                      : await updateRecordInTransaction(
                          unit,
                          context.orgId,
                          operation.collection,
                          operation.id,
                          operation.data,
                          undefined,
                          undefined,
                          grants,
                          context.userId,
                        );
                  id = record.id;
                  results.push({ op: operation.op, record });
                  if (key !== undefined) {
                    const row = await unit.db.record.findUniqueOrThrow({
                      where: { id },
                    });
                    visibility.push({
                      ...record,
                      data: row.data as Record<string, unknown>,
                    });
                  }
                }
                await unit.db.auditLog.create({
                  data: {
                    id: genId(),
                    orgId: context.orgId,
                    userId: context.userId,
                    action:
                      action === "create"
                        ? "insert_record"
                        : `${action}_record`,
                    resourceType: "record",
                    resourceId: id,
                    details: { collection: operation.collection },
                  },
                });
              }
              const response = { results };
              if (key !== undefined)
                await unit.db.transactionRequest.create({
                  data: {
                    id: genId(),
                    ...scope,
                    requestHash: hash!,
                    response: json(response),
                    visibility: json(visibility),
                    expiresAt: new Date(now.getTime() + retentionMs),
                    createdAt: now,
                  },
                });
              return response;
            },
            { maxWait: 10_000, timeout: 30_000 },
          );
        } catch (error) {
          if (
            attempt >= 2 ||
            !(error instanceof Prisma.PrismaClientKnownRequestError) ||
            !["P2034", "P1008"].includes(error.code)
          )
            throw error;
        }
      }
    },
  };
}

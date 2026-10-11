import { parseRequest as parse } from "../lib/transport";
import {
  AutomationConflictError,
  AutomationNotFoundError,
  LastSaasError,
  PermissionDeniedError,
  SchemaValidationError,
  genId,
  pageRequestSchema,
  resourceNameSchema,
  secretCreateSchema,
  secretReplaceSchema,
  type AutomationContext,
  type SecretKeyring,
  type SecretMetadata,
  type SecretService,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Enforcer } from "casbin";
import { createOrgEnforcer } from "../db/casbin";
import { decryptSecret, encryptSecret } from "./crypto";

const metadataSelect = {
  id: true,
  orgId: true,
  name: true,
  keyVersion: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SecretSelect;
type MetadataRow = Prisma.SecretGetPayload<{ select: typeof metadataSelect }>;

function metadata(row: MetadataRow): SecretMetadata {
  return {
    id: row.id,
    organization_id: row.orgId,
    name: row.name,
    key_version: row.keyVersion,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// Schema/parser errors can contain request values. Publish only fixed messages.

const cursorSchema = z.strictObject({
  resource: z.literal("secrets:v1"),
  orgId: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string().min(1).max(128),
});

function decodeCursor(cursor: string, orgId: string) {
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error();
    const position = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (position.orgId !== orgId) throw new Error();
    return { createdAt: new Date(position.createdAt), id: position.id };
  } catch {
    throw new SchemaValidationError(["Invalid secrets cursor"]);
  }
}

function encodeCursor(row: MetadataRow): string {
  return Buffer.from(
    JSON.stringify({
      resource: "secrets:v1",
      orgId: row.orgId,
      createdAt: row.createdAt.toISOString(),
      id: row.id,
    }),
  ).toString("base64url");
}

async function authorize(
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
  // Transaction clients are intentionally uncached: every operation checks current grants.
  return createOrgEnforcer(db, context.orgId);
}

async function requireGate(
  enforcer: Enforcer,
  context: AutomationContext,
  resource: string,
  action: string,
) {
  if (!(await enforcer.enforce(context.userId, resource, action)))
    throw new PermissionDeniedError();
}

async function findSecret(
  db: Prisma.TransactionClient,
  context: AutomationContext,
  name: string,
) {
  parse(resourceNameSchema, name);
  const row = await db.secret.findUnique({
    where: { orgId_name: { orgId: context.orgId, name } },
    select: metadataSelect,
  });
  if (!row) throw new AutomationNotFoundError();
  return row;
}

async function audit(
  db: Prisma.TransactionClient,
  context: AutomationContext,
  action: string,
  id: string | null,
  details?: Prisma.InputJsonObject,
) {
  await db.auditLog.create({
    data: {
      id: genId(),
      orgId: context.orgId,
      userId: context.userId,
      action,
      resourceType: "secret",
      resourceId: id,
      details: details ?? Prisma.DbNull,
    },
  });
}

/** Context-first secret operations; rotation is exposed only to operator tooling. */
export function createSecretService(
  prisma: PrismaClient,
  keyring: SecretKeyring | null,
): SecretService {
  return {
    async create(context, input) {
      const parsed = parse(secretCreateSchema, input);
      try {
        return await prisma.$transaction(async (db) => {
          const enforcer = await authorize(db, context);
          await requireGate(enforcer, context, "/secrets", "write");
          const identity = { orgId: context.orgId, id: genId() };
          const row = await db.secret.create({
            data: {
              ...identity,
              name: parsed.name,
              ...encryptSecret(keyring, identity, parsed.value),
            },
            select: metadataSelect,
          });
          await audit(db, context, "create_secret", row.id);
          return metadata(row);
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
          throw new AutomationConflictError("Secret name already exists");
        throw error;
      }
    },
    async list(context, input) {
      const { limit, cursor } = parse(pageRequestSchema, input);
      const position = cursor ? decodeCursor(cursor, context.orgId) : null;
      return prisma.$transaction(async (db) => {
        const enforcer = await authorize(db, context);
        const candidates = await db.secret.findMany({
          where: {
            orgId: context.orgId,
            ...(position
              ? {
                  OR: [
                    { createdAt: { gt: position.createdAt } },
                    { createdAt: position.createdAt, id: { gt: position.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit + 1,
          select: metadataSelect,
        });
        const scanned = candidates.slice(0, limit);
        const items: SecretMetadata[] = [];
        for (const row of scanned) {
          if (
            await enforcer.enforce(
              context.userId,
              `/secrets/${row.name}`,
              "read",
            )
          )
            items.push(metadata(row));
        }
        return {
          items,
          next_cursor:
            candidates.length > limit
              ? encodeCursor(scanned[scanned.length - 1]!)
              : null,
        };
      });
    },
    async show(context, name) {
      return prisma.$transaction(async (db) => {
        const enforcer = await authorize(db, context);
        const row = await findSecret(db, context, name);
        await requireGate(enforcer, context, `/secrets/${row.name}`, "read");
        return metadata(row);
      });
    },
    async replace(context, name, input) {
      const parsed = parse(secretReplaceSchema, input);
      return prisma.$transaction(async (db) => {
        const enforcer = await authorize(db, context);
        const row = await findSecret(db, context, name);
        await requireGate(enforcer, context, `/secrets/${row.name}`, "manage");
        const updated = await db.secret.update({
          where: { id: row.id },
          data: encryptSecret(keyring, row, parsed.value),
          select: metadataSelect,
        });
        await audit(db, context, "replace_secret", row.id);
        return metadata(updated);
      });
    },
    async delete(context, name) {
      await prisma.$transaction(async (db) => {
        const enforcer = await authorize(db, context);
        const row = await findSecret(db, context, name);
        await requireGate(enforcer, context, `/secrets/${row.name}`, "delete");
        await db.secret.delete({ where: { id: row.id } });
        await audit(db, context, "delete_secret", row.id);
      });
    },
    async reveal(context, name) {
      const result = await prisma.$transaction(async (db) => {
        const enforcer = await authorize(db, context);
        let id: string | null = null;
        try {
          const row = await findSecret(db, context, name);
          id = row.id;
          await requireGate(
            enforcer,
            context,
            `/secrets/${row.name}/value`,
            "read",
          );
          const encrypted = await db.secret.findUniqueOrThrow({
            where: { id: row.id },
          });
          const value = decryptSecret(keyring, row, encrypted);
          await audit(db, context, "reveal_secret", row.id, {
            outcome: "succeeded",
          });
          return { secret: { id: row.id, name: row.name, value } };
        } catch (error) {
          if (!(error instanceof LastSaasError)) throw error;
          await audit(db, context, "reveal_secret", id, {
            outcome: "failed",
            error: error.code,
          });
          // Throw after commit so denied/unavailable reveal attempts remain audited.
          return { error };
        }
      });
      if (result.error) throw result.error;
      return result.secret!;
    },
  };
}

import { validateCollectionRules } from "./collection-rules";
import type { CollectionValidation } from "@lastsaas/shared";
import {
  cachedMetadata,
  collectionCacheKey,
  policyCacheKey,
  invalidateMetadata,
} from "./cache";
import { sql, queryRows } from "./query/kysely";
import { queryProvider } from "./provider";
import { queryAdapter } from "./query/adapters";
import {
  CollectionExistsError,
  RelationshipConflictError,
  CollectionNotFoundError,
  SchemaValidationError,
  applyFieldUpdate,
  genId,
  isPlainObject,
  validateFieldUpdates,
  validateSchema,
  type Schema,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

function asSchema(value: Prisma.JsonValue): Schema {
  if (!isPlainObject(value)) {
    throw new SchemaValidationError([
      "Corrupt schema in database (expected an object)",
    ]);
  }
  return value as Schema;
}

function schemaJson(schema: Schema): Prisma.InputJsonObject {
  return schema as Prisma.InputJsonObject;
}

function serializeCollection(collection: {
  id: string;
  name: string;
  schema: Prisma.JsonValue;
  validations: Prisma.JsonValue;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: collection.id,
    name: collection.name,
    schema: asSchema(collection.schema),
    validations: collection.validations as unknown as CollectionValidation[],
    description: collection.description,
    created_at: collection.createdAt.toISOString(),
    updated_at: collection.updatedAt.toISOString(),
  };
}

export async function createCollection(
  prisma: PrismaClient,
  orgId: string,
  creatorUserId: string | null,
  name: string,
  schema: Schema,
  description = "",
  validations: CollectionValidation[] = [],
) {
  validateCollectionRules(validations, schema);
  const errors = validateSchema(schema);
  if (errors.length > 0) throw new SchemaValidationError(errors);

  try {
    const collection = await prisma.$transaction(async (transaction) => {
      const created = await transaction.collection.create({
        data: {
          id: genId(),
          orgId,
          name,
          schema: schemaJson(schema),
          validations: validations as unknown as Prisma.InputJsonArray,
          description,
        },
      });
      if (creatorUserId) {
        await transaction.casbinRule.createMany({
          data: [
            ...["read", "create", "update", "manage", "delete"].map(
              (action) => ({
                orgId,
                ptype: "p",
                v0: creatorUserId,
                v1: `/collections/${name}`,
                v2: action,
                v3: "true",
                v4: "",
              }),
            ),
            ...["read", "create", "update"].map((action) => ({
              orgId,
              ptype: "p",
              v0: creatorUserId,
              v1: `/collections/${name}/fields/*`,
              v2: action,
              v3: "true",
              v4: "",
            })),
          ],
        });
      }
      return created;
    });
    return serializeCollection(collection);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new CollectionExistsError(name);
    }
    throw error;
  } finally {
    await invalidateMetadata(
      prisma,
      collectionCacheKey(orgId, name),
      policyCacheKey(orgId),
    );
  }
}

export async function listCollections(prisma: PrismaClient, orgId: string) {
  const collections = await prisma.collection.findMany({
    where: { orgId },
    orderBy: { name: "asc" },
  });
  return collections.map(serializeCollection);
}

export async function describeCollection(
  prisma: PrismaClient,
  orgId: string,
  name: string,
) {
  return serializeCollection(await getCollection(prisma, orgId, name));
}

export async function updateCollectionSchema(
  prisma: PrismaClient,
  orgId: string,
  name: string,
  addFields?: Schema,
  removeFields?: string[],
  updateFields?: Record<string, Record<string, unknown>>,
  validations?: CollectionValidation[],
) {
  const collection = await getCollection(prisma, orgId, name);
  const schema = { ...asSchema(collection.schema) };

  if (addFields && Object.keys(addFields).length > 0) {
    const errors = validateSchema(addFields);
    if (errors.length > 0) throw new SchemaValidationError(errors);
    const adapter = queryAdapter(queryProvider(prisma));
    for (const field of Object.keys(addFields)) {
      if (Object.hasOwn(schema, field)) {
        throw new SchemaValidationError([
          `Field '${field}' already exists (use update_fields to change it)`,
        ]);
      } else {
        // Removing a field leaves its JSON data intact. Do not let re-adding
        // that name silently reinterpret those values as a different schema.
        const rows = await queryRows<{ id: string }>(
          prisma,
          queryProvider(prisma),
          sql`SELECT id FROM records WHERE org_id = ${orgId} AND collection_id = ${collection.id} AND ${adapter.fieldExists(field)} LIMIT 1`,
        );
        if (rows.length)
          throw new SchemaValidationError([
            `Field '${field}': reusing a removed field with stored data is unsupported`,
          ]);
      }
    }
    Object.assign(schema, addFields);
  }

  for (const fieldName of removeFields ?? []) delete schema[fieldName];

  if (updateFields && Object.keys(updateFields).length > 0) {
    const errors = validateFieldUpdates(updateFields, schema);
    if (errors.length > 0) throw new SchemaValidationError(errors);
    for (const [fieldName, update] of Object.entries(updateFields)) {
      schema[fieldName] = applyFieldUpdate(schema[fieldName]!, update);
    }
  }

  if (Object.keys(schema).length === 0) {
    throw new SchemaValidationError([
      "Schema cannot be empty after removing fields",
    ]);
  }

  const rules = validateCollectionRules(
    validations ?? collection.validations,
    schema,
  );

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (removeFields?.length) {
        const records = { orgId, collectionId: collection.id };
        await tx.recordReference.deleteMany({
          where: { orgId, field: { in: removeFields }, source: records },
        });
        await tx.recordAttachment.deleteMany({
          where: { orgId, field: { in: removeFields }, record: records },
        });
      }
      return tx.collection.update({
        where: { id: collection.id },
        data: {
          schema: schemaJson(schema),
          validations: rules as unknown as Prisma.InputJsonArray,
        },
      });
    });
    return serializeCollection(updated);
  } finally {
    await invalidateMetadata(prisma, collectionCacheKey(orgId, name));
  }
}

export async function dropCollection(
  prisma: PrismaClient,
  orgId: string,
  name: string,
): Promise<void> {
  const collection = await getCollection(prisma, orgId, name);
  try {
    await prisma.$transaction(async (transaction) => {
      if (queryProvider(prisma) === "postgresql") {
        await queryRows(
          transaction,
          "postgresql",
          sql`SELECT id FROM collections WHERE id = ${collection.id} AND org_id = ${orgId} FOR UPDATE`,
        );
        await queryRows(
          transaction,
          "postgresql",
          sql`SELECT id FROM records WHERE collection_id = ${collection.id} AND org_id = ${orgId} ORDER BY id FOR UPDATE`,
        );
      }
      await transaction.recordReference.deleteMany({
        where: { orgId, source: { collectionId: collection.id } },
      });
      const dependents = await transaction.recordReference.count({
        where: { orgId, target: { collectionId: collection.id } },
      });
      if (dependents) throw new RelationshipConflictError();
      await transaction.collection.delete({ where: { id: collection.id } });
      await transaction.casbinRule.deleteMany({
        where: {
          orgId,
          ptype: "p",
          v1: `/collections/${name}`,
        },
      });
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2003"
    )
      throw new RelationshipConflictError();
    throw error;
  } finally {
    await invalidateMetadata(
      prisma,
      collectionCacheKey(orgId, name),
      policyCacheKey(orgId),
    );
  }
}

export async function getCollection(
  prisma: PrismaClient,
  orgId: string,
  name: string,
) {
  const collection = await cachedMetadata(
    prisma,
    collectionCacheKey(orgId, name),
    async () => {
      const row = await getCollectionInTransaction(prisma, orgId, name);
      return {
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  );
  return {
    ...collection,
    createdAt: new Date(collection.createdAt),
    updatedAt: new Date(collection.updatedAt),
  };
}

/** Read the transaction's schema, without caching uncommitted metadata. */
export async function getCollectionInTransaction(
  db: Prisma.TransactionClient,
  orgId: string,
  name: string,
) {
  const row = await db.collection.findUnique({
    where: { orgId_name: { orgId, name } },
  });
  if (!row) throw new CollectionNotFoundError(name);
  asSchema(row.schema);
  return row;
}

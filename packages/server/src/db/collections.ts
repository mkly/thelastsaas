import {
  CollectionExistsError,
  CollectionNotFoundError,
  SchemaValidationError,
  applyFieldUpdate,
  extractFieldType,
  genId,
  isPlainObject,
  validateFieldUpdates,
  validateRecordData,
  validateSchema,
  type Schema,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

import { validateRecurrence } from "../lib/recurrence";

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
  description: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: collection.id,
    name: collection.name,
    schema: asSchema(collection.schema),
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
) {
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
          description,
        },
      });
      if (creatorUserId) {
        await transaction.casbinRule.createMany({
          data: ["read", "write", "manage", "delete"].map((action) => ({
            orgId,
            ptype: "p",
            v0: creatorUserId,
            v1: `/collections/${name}`,
            v2: action,
          })),
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
) {
  const collection = await getCollection(prisma, orgId, name);
  const schema = { ...asSchema(collection.schema) };

  if (addFields && Object.keys(addFields).length > 0) {
    const errors = validateSchema(addFields);
    if (errors.length > 0) throw new SchemaValidationError(errors);
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

  const updated = await prisma.collection.update({
    where: { id: collection.id },
    data: { schema: schemaJson(schema) },
  });
  return serializeCollection(updated);
}

export async function dropCollection(
  prisma: PrismaClient,
  orgId: string,
  name: string,
): Promise<void> {
  const collection = await getCollection(prisma, orgId, name);
  await prisma.$transaction(async (transaction) => {
    await transaction.collection.delete({ where: { id: collection.id } });
    await transaction.casbinRule.deleteMany({
      where: {
        orgId,
        ptype: "p",
        v1: `/collections/${name}`,
      },
    });
  });
}

export async function getCollection(
  prisma: PrismaClient,
  orgId: string,
  name: string,
) {
  const collection = await prisma.collection.findUnique({
    where: { orgId_name: { orgId, name } },
  });
  if (!collection) throw new CollectionNotFoundError(name);
  asSchema(collection.schema);
  return collection;
}

/**
 * Validate data written against a collection schema. Recurrence values use the
 * full RFC 5545 parser rather than the shared package's inexpensive shape
 * check. Record-write routes should use this entry point.
 */
export function validateCollectionRecordData(
  data: Record<string, unknown>,
  schema: Schema,
): string[] {
  const errors = validateRecordData(data, schema);
  for (const [fieldName, fieldDefinition] of Object.entries(schema)) {
    if (extractFieldType(fieldDefinition) !== "recurrence") continue;
    const value = data[fieldName];
    if (typeof value !== "string") continue;
    // The engine, not the shared shape check, is authoritative here: it accepts
    // folded lines and repeated EXDATEs that the cheap regex rejects. Drop the
    // shape verdict for this field and re-decide with the parser.
    const message = `Field '${fieldName}': invalid recurrence value`;
    const shapeIndex = errors.indexOf(message);
    if (shapeIndex !== -1) errors.splice(shapeIndex, 1);
    try {
      validateRecurrence(value);
    } catch {
      errors.push(message);
    }
  }
  return errors;
}

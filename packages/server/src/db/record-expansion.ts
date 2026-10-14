import {
  expandSchema,
  extractFieldType,
  isMultipleReference,
  InvalidQueryError,
  type CollectionRecord,
  type Schema,
} from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import type { Principal } from "./query/compile";
import { getCollection } from "./collections";
import { resolveRecordGrants } from "./record-grants";
import { getRecord, queryRecords } from "./records";
import { formatFile } from "./files";
import { linkIds, referenceDefinitions } from "./record-links";

/** Batched expansion operates only on already-projected source data. */
export async function expandRecords(
  db: PrismaClient,
  principal: Principal,
  collection: string,
  records: CollectionRecord[],
  paths: string[] = [],
  budget = { objects: 0 },
): Promise<CollectionRecord[]> {
  if (!expandSchema.safeParse(paths).success)
    throw new InvalidQueryError(
      "Expand accepts up to 20 reference paths, at most four fields deep",
    );
  const schema = (await getCollection(db, principal.orgId, collection))
    .schema as Schema;
  const output = records.map((record) => ({ ...record }));
  const fileIds = [
    ...new Set(
      output.flatMap((record) =>
        Object.entries(record.data).flatMap(([field, value]) =>
          extractFieldType(schema[field]!) === "attachments"
            ? linkIds(value)
            : [],
        ),
      ),
    ),
  ];
  budget.objects += fileIds.length;
  if (budget.objects > 2000)
    throw new InvalidQueryError(
      "Expansion exceeds 2000 objects; reduce the page size or expand paths",
    );
  const files = fileIds.length
    ? await db.file.findMany({
        where: { orgId: principal.orgId, id: { in: fileIds } },
      })
    : [];
  const fileMap = new Map(files.map((file) => [file.id, formatFile(file)]));
  for (const record of output) {
    for (const [field, value] of Object.entries(record.data)) {
      if (extractFieldType(schema[field]!) !== "attachments") continue;
      record.attachments ??= {};
      record.attachments[field] = linkIds(value).flatMap((id) =>
        fileMap.has(id) ? [fileMap.get(id)!] : [],
      );
    }
  }
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const [field, ...rest] = path.split(".");
    const type = extractFieldType(schema[field!]!);
    if (!type?.startsWith("ref:"))
      throw new InvalidQueryError(`Expand field '${field}' is not a reference`);
    if (!groups.has(field!)) groups.set(field!, []);
    if (rest.length) groups.get(field!)!.push(rest.join("."));
  }
  for (const [field, nested] of groups) {
    const targetName = extractFieldType(schema[field]!)!.slice(4);
    const target = await db.collection.findUnique({
      where: { orgId_name: { orgId: principal.orgId, name: targetName } },
    });
    const ids = [
      ...new Set(output.flatMap((record) => linkIds(record.data[field]))),
    ];
    budget.objects += ids.length;
    if (budget.objects > 2000)
      throw new InvalidQueryError(
        "Expansion exceeds 2000 objects; reduce the page size or expand paths",
      );
    const grants = target
      ? await resolveRecordGrants(
          db,
          principal,
          target.id,
          `/collections/${targetName}`,
          "read",
        )
      : [];
    let children: CollectionRecord[] = [];
    if (target && grants.length) {
      for (let i = 0; i < ids.length; i += 500) {
        const page = await queryRecords(
          db,
          principal.orgId,
          targetName,
          { id: { in: ids.slice(i, i + 500) } },
          undefined,
          500,
          0,
          null,
          null,
          grants,
          principal,
        );
        children.push(...page.records);
      }
      children = await expandRecords(
        db,
        principal,
        targetName,
        children,
        [...new Set(nested)],
        budget,
      );
    }
    const byId = new Map(children.map((record) => [record.id, record]));
    for (const record of output) {
      if (!Object.hasOwn(record.data, field)) continue;
      record.expand ??= {};
      record.expand[field] = isMultipleReference(schema[field]!)
        ? linkIds(record.data[field]).map((id) => byId.get(id) ?? null)
        : (byId.get(String(record.data[field])) ?? null);
    }
  }
  return output;
}

export async function describeRelationships(
  db: PrismaClient,
  principal: Principal,
  collectionName: string,
) {
  const collections = await db.collection.findMany({
    where: { orgId: principal.orgId },
  });
  const inbound: Array<{
    collection: string;
    field: string;
    multiple: boolean;
  }> = [];
  const outbound: Array<{
    collection: string;
    field: string;
    multiple: boolean;
  }> = [];
  for (const collection of collections) {
    const grants = await resolveRecordGrants(
      db,
      principal,
      collection.id,
      `/collections/${collection.name}`,
      "read",
    );
    for (const reference of referenceDefinitions(collection.schema as Schema)) {
      if (
        !grants.some(
          (grant) =>
            grant.readable === undefined ||
            grant.readable.includes(reference.field),
        )
      )
        continue;
      if (collection.name === collectionName) outbound.push(reference);
      if (reference.collection === collectionName)
        inbound.push({ ...reference, collection: collection.name });
    }
  }
  return { inbound, outbound };
}

export async function relatedRecords(
  db: PrismaClient,
  principal: Principal,
  collectionName: string,
  recordId: string,
  input: import("@lastsaas/shared").RelatedRecordsQuery,
) {
  const target = await getCollection(db, principal.orgId, collectionName);
  const targetGrants = await resolveRecordGrants(
    db,
    principal,
    target.id,
    `/collections/${collectionName}`,
    "read",
  );
  await getRecord(
    db,
    principal.orgId,
    collectionName,
    recordId,
    null,
    null,
    targetGrants,
  );
  const source = await getCollection(
    db,
    principal.orgId,
    input.source_collection,
  );
  const definition = (source.schema as Schema)[input.field];
  if (extractFieldType(definition!) !== `ref:${collectionName}`)
    throw new InvalidQueryError(
      "Source field does not reference this collection",
    );
  const grants = await resolveRecordGrants(
    db,
    principal,
    source.id,
    `/collections/${source.name}`,
    "read",
  );
  const link = {
    [input.field]: isMultipleReference(definition!)
      ? { has: recordId }
      : recordId,
  };
  const where = input.where ? { and: [link, input.where] } : link;
  const result = await queryRecords(
    db,
    principal.orgId,
    source.name,
    where,
    input.order_by,
    input.limit,
    input.offset,
    null,
    null,
    grants,
    principal,
  );
  return {
    ...result,
    records: await expandRecords(
      db,
      principal,
      source.name,
      result.records,
      input.expand,
    ),
  };
}

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createCollection, dropCollection } from "../src/db/collections";
import {
  insertRecord,
  insertRecords,
  updateRecord,
  deleteRecord,
  queryRecords,
  aggregateRecords,
} from "../src/db/records";
import {
  expandRecords,
  relatedRecords,
  describeRelationships,
} from "../src/db/record-expansion";
import { addPolicy } from "../src/db/casbin";
import { resolveRecordGrants } from "../src/db/record-grants";
import { registerDatabaseProvider } from "../src/db/provider";
import {
  createUpload,
  prepareUpload,
  getUpload,
  writeUpload,
  completeUpload,
} from "../src/uploads";
import { createDownloadLink, downloadLocalFile } from "../src/file-downloads";
import { deleteFile, listFiles } from "../src/db/files";
import { pruneRecordHistory } from "../src/db/record-history-storage";
import { queryRecordHistory } from "../src/db/record-history";
import { LocalStorage } from "../src/storage/local";
import { loadConfig } from "../src/config";
import type { AppServices } from "../src/services";
import type { AppEnvironment } from "../src/env";
import { recordsRouter } from "../src/routes/records";
import { fileRouter } from "../src/routes/files";
import { testMigrationSql } from "./test-migrations";
import { createTransactionService } from "../src/transactions/service";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerOperationsTools } from "../src/mcp/tools/operations";
import { registerDataTools } from "../src/mcp/tools/data";

const postgresUrl = process.env.RELATIONSHIPS_TEST_DATABASE_URL;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lastsaas-links-"));
  const url = postgresUrl ?? `file:${dir}/test.db`;
  if (!postgresUrl) {
    const sqlite = new Database(`${dir}/test.db`);
    sqlite.exec(testMigrationSql);
    sqlite.close();
  }
  const db = new PrismaClient({ datasourceUrl: url });
  registerDatabaseProvider(db, url);
  const orgId = crypto.randomUUID();
  const admin = {
    orgId,
    userId: crypto.randomUUID(),
    userEmail: `${crypto.randomUUID()}@example.com`,
  };
  const reader = {
    orgId,
    userId: crypto.randomUUID(),
    userEmail: `${crypto.randomUUID()}@example.com`,
  };
  await db.organization.create({
    data: { id: orgId, slug: orgId, name: "Links" },
  });
  for (const actor of [admin, reader]) {
    await db.user.create({
      data: { id: actor.userId, email: actor.userEmail, name: "Actor" },
    });
    await db.member.create({
      data: {
        id: crypto.randomUUID(),
        userId: actor.userId,
        organizationId: orgId,
      },
    });
  }
  await addPolicy(db, orgId, admin.userId, "/*", "*");
  const companies = await createCollection(
    db,
    orgId,
    admin.userId,
    "companies",
    {
      name: "string",
      visible: "boolean",
      secret: "string",
      parent: "ref:companies",
    },
  );
  const contacts = await createCollection(db, orgId, admin.userId, "contacts", {
    name: "string",
    company: "ref:companies",
    partners: { type: "ref:companies", multiple: true },
    documents: "attachments",
    visible: "boolean",
  });
  const storage = new LocalStorage(`${dir}/files`);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: url,
    STORAGE_PATH: `${dir}/files`,
    BETTER_AUTH_URL: "http://localhost:8787",
  });
  const services = { prisma: db, storage } as unknown as AppServices;
  cleanups.push(async () => {
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.user.deleteMany({
      where: { id: { in: [admin.userId, reader.userId] } },
    });
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });
  const grants = (actor = admin, collection = contacts) =>
    resolveRecordGrants(
      db,
      actor,
      collection.id,
      `/collections/${collection.name}`,
      "read",
    );
  const appFor = (actor = admin) => {
    const app = new Hono<AppEnvironment>();
    app.use("*", async (c, next) => {
      c.set("services", services);
      c.set("config", config);
      c.set("orgId", orgId);
      c.set("userId", actor.userId);
      c.set("audit", async () => {});
      await next();
    });
    app.route("/collections/:name/records", recordsRouter);
    app.route("/files", fileRouter);
    return app;
  };
  return {
    db,
    orgId,
    admin,
    reader,
    companies,
    contacts,
    storage,
    config,
    services,
    grants,
    appFor,
  };
}

test("references validate targets, preserve list order, and restrict record and collection deletion", async () => {
  const f = await fixture();
  const a = await insertRecord(
    f.db,
    f.orgId,
    "companies",
    { name: "A" },
    f.admin.userId,
  );
  const b = await insertRecord(
    f.db,
    f.orgId,
    "companies",
    { name: "B" },
    f.admin.userId,
  );
  const contact = await insertRecord(
    f.db,
    f.orgId,
    "contacts",
    { name: "Ada", company: a.id, partners: [b.id, a.id] },
    f.admin.userId,
  );
  expect(
    (
      await f.db.recordReference.findMany({
        where: { sourceId: contact.id, field: "partners" },
        orderBy: { position: "asc" },
      })
    ).map((row) => row.targetId),
  ).toEqual([b.id, a.id]);
  await expect(
    insertRecord(
      f.db,
      f.orgId,
      "contacts",
      { company: contact.id },
      f.admin.userId,
    ),
  ).rejects.toThrow("unavailable");
  await expect(
    insertRecord(f.db, f.orgId, "contacts", { company: a.id }, f.reader.userId),
  ).rejects.toThrow("unavailable");
  await expect(
    insertRecord(
      f.db,
      f.orgId,
      "contacts",
      { partners: [a.id, a.id] },
      f.admin.userId,
    ),
  ).rejects.toThrow("unique");
  await expect(deleteRecord(f.db, f.orgId, "companies", a.id)).rejects.toThrow(
    "referenced",
  );
  await expect(dropCollection(f.db, f.orgId, "companies")).rejects.toThrow(
    "referenced",
  );
  expect(
    await f.db.recordReference.count({ where: { sourceId: contact.id } }),
  ).toBe(3);
  await updateRecord(
    f.db,
    f.orgId,
    "contacts",
    contact.id,
    { company: null, partners: [] },
    null,
    null,
    undefined,
    f.admin.userId,
  );
  await deleteRecord(f.db, f.orgId, "companies", a.id);
  expect(
    await f.db.recordReference.count({ where: { sourceId: contact.id } }),
  ).toBe(0);
});

test("relationship queries filter in SQL before count, aggregate and pagination; nested expansion uses target permissions", async () => {
  const f = await fixture();
  const parent = await insertRecord(
    f.db,
    f.orgId,
    "companies",
    { name: "Parent", visible: true },
    f.admin.userId,
  );
  const allowed = await insertRecord(
    f.db,
    f.orgId,
    "companies",
    { name: "Allowed", visible: true, secret: "hidden", parent: parent.id },
    f.admin.userId,
  );
  const denied = await insertRecord(
    f.db,
    f.orgId,
    "companies",
    { name: "Denied", visible: false },
    f.admin.userId,
  );
  await insertRecords(
    f.db,
    f.orgId,
    "contacts",
    [
      { name: "One", company: allowed.id, partners: [denied.id, allowed.id] },
      { name: "Two", company: denied.id, partners: [] },
      { name: "Three", company: allowed.id, partners: [denied.id] },
    ],
    f.admin.userId,
  );
  await addPolicy(
    f.db,
    f.orgId,
    f.reader.userId,
    "/collections/contacts",
    "read",
  );
  await addPolicy(
    f.db,
    f.orgId,
    f.reader.userId,
    "/collections/companies",
    "read",
    { where: { visible: true }, fields: ["name", "parent", "visible"] },
  );
  const grants = await f.grants(f.reader);
  const page = await queryRecords(
    f.db,
    f.orgId,
    "contacts",
    { company: { some: { name: "Allowed" } } },
    "name",
    1,
    1,
    null,
    null,
    grants,
    f.reader,
  );
  expect(page.total).toBe(2);
  expect(page.records[0]!.data.name).toBe("Three");
  const all = await queryRecords(
    f.db,
    f.orgId,
    "contacts",
    { partners: { every: { name: "Allowed" } } },
    undefined,
    50,
    0,
    null,
    null,
    grants,
    f.reader,
  );
  expect(all.total).toBe(3); // Empty/hidden-only sets satisfy every.
  const none = await queryRecords(
    f.db,
    f.orgId,
    "contacts",
    { partners: { none: { name: "Allowed" } } },
    undefined,
    50,
    0,
    null,
    null,
    grants,
    f.reader,
  );
  expect(none.total).toBe(2);
  const some = await queryRecords(
    f.db,
    f.orgId,
    "contacts",
    { company: { some: { parent: { some: { name: "Parent" } } } } },
    undefined,
    50,
    0,
    null,
    null,
    grants,
    f.reader,
  );
  expect(some.total).toBe(2);
  const aggregation = await aggregateRecords(
    f.db,
    f.orgId,
    "contacts",
    {
      where: { company: { some: { name: "Allowed" } } },
      metrics: [{ op: "count", as: "total" }],
    },
    null,
    null,
    grants,
    f.reader,
  );
  expect(aggregation.rows[0]!.total).toBe(2);
  const one = await queryRecords(
    f.db,
    f.orgId,
    "contacts",
    { name: "One" },
    undefined,
    50,
    0,
    null,
    null,
    grants,
    f.reader,
  );
  const [expanded] = await expandRecords(
    f.db,
    f.reader,
    "contacts",
    one.records,
    ["company.parent", "partners"],
  );
  expect(expanded!.expand!.company).toMatchObject({
    data: { name: "Allowed" },
    expand: { parent: { data: { name: "Parent" } } },
  });
  expect(JSON.stringify(expanded!.expand)).not.toContain("hidden");
  expect((expanded!.expand!.partners as unknown[])[0]).toBeNull();
  expect(
    (
      await relatedRecords(f.db, f.reader, "companies", allowed.id, {
        source_collection: "contacts",
        field: "company",
      })
    ).total,
  ).toBe(2);
  expect(
    (await describeRelationships(f.db, f.reader, "companies")).inbound,
  ).toContainEqual({
    collection: "contacts",
    field: "company",
    multiple: false,
  });
  await expect(
    queryRecords(
      f.db,
      f.orgId,
      "contacts",
      { company: { some: { secret: "hidden" } } },
      undefined,
      50,
      0,
      null,
      null,
      grants,
      f.reader,
    ),
  ).rejects.toThrow("not allowed");
});

async function uploadAttachment(
  f: Awaited<ReturnType<typeof fixture>>,
  recordId: string,
  actor = f.admin,
) {
  return completeUpload(f.services, await stageAttachment(f, recordId, actor));
}

async function stageAttachment(
  f: Awaited<ReturnType<typeof fixture>>,
  recordId: string,
  actor = f.admin,
) {
  const attachment = {
    collection: "contacts",
    record_id: recordId,
    field: "documents",
  };
  const session = await createUpload(
    f.services,
    f.config,
    f.orgId,
    actor.userId,
    attachment,
  );
  const current = () =>
    getUpload(f.services, session.upload.id, { token: session.token });
  await prepareUpload(f.services, f.config, await current(), session.token, {
    filename: "contract.txt",
    size_bytes: 5,
    attachment,
  });
  await writeUpload(f.services, await current(), new Blob(["hello"]).stream());
  return current();
}

test.skipIf(!postgresUrl)(
  "overlapping attachment completions append every uploaded file",
  async () => {
    const f = await fixture();
    const record = await insertRecord(
      f.db,
      f.orgId,
      "contacts",
      { name: "Deal", documents: [] },
      f.admin.userId,
    );
    const uploads = [];
    for (let i = 0; i < 3; i++)
      uploads.push(await stageAttachment(f, record.id));
    const completed = await Promise.allSettled(
      uploads.map((upload) => completeUpload(f.services, upload)),
    );
    expect(completed.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    const saved = await f.db.record.findUniqueOrThrow({
      where: { id: record.id },
    });
    expect(
      [...(saved.data as { documents: string[] }).documents].sort(),
    ).toEqual(uploads.map((upload) => upload.id).sort());
    expect(
      await f.db.recordAttachment.count({ where: { recordId: record.id } }),
    ).toBe(3);
  },
);

test("file delete grants can remove detached attachments after retained history expires", async () => {
  const f = await fixture();
  const record = await insertRecord(
    f.db,
    f.orgId,
    "contacts",
    { name: "Deal", documents: [] },
    f.admin.userId,
  );
  const file = await uploadAttachment(f, record.id);
  await addPolicy(f.db, f.orgId, f.reader.userId, "/files", "delete");
  const app = f.appFor(f.reader);
  expect((await app.request(`/files/${file.id}`)).status).toBe(404);
  expect(
    (await app.request(`/files/${file.id}`, { method: "DELETE" })).status,
  ).toBe(409);
  await updateRecord(
    f.db,
    f.orgId,
    "contacts",
    record.id,
    { documents: [] },
    null,
    null,
    undefined,
    f.admin.userId,
  );
  expect(
    (await app.request(`/files/${file.id}`, { method: "DELETE" })).status,
  ).toBe(409);
  await f.db.recordHistory.updateMany({
    where: { orgId: f.orgId },
    data: { createdAt: new Date(0) },
  });
  await pruneRecordHistory(f.db);
  expect(
    (await app.request(`/files/${file.id}`, { method: "DELETE" })).status,
  ).toBe(200);
  expect(await f.db.file.findUnique({ where: { id: file.id } })).toBeNull();
  expect(await f.storage.stat(`${f.orgId}/${file.id}`)).toBeNull();
});

test("links reject other organizations and batch validation preserves valid records", async () => {
  const f = await fixture();
  const foreign = await fixture();
  const target = await insertRecord(
    foreign.db,
    foreign.orgId,
    "companies",
    { name: "Foreign" },
    foreign.admin.userId,
  );
  const source = await insertRecord(
    foreign.db,
    foreign.orgId,
    "contacts",
    { name: "Foreign", documents: [] },
    foreign.admin.userId,
  );
  const file = await uploadAttachment(foreign, source.id);
  const batch = await insertRecords(
    f.db,
    f.orgId,
    "contacts",
    [{ name: "Valid" }, { company: target.id }, { documents: [file.id] }],
    f.admin.userId,
  );
  expect(batch.inserted).toBe(1);
  expect(batch.errors?.map((error) => error.index)).toEqual([1, 2]);
  expect(await f.db.recordReference.count({ where: { orgId: f.orgId } })).toBe(
    0,
  );
  expect(await f.db.recordAttachment.count({ where: { orgId: f.orgId } })).toBe(
    0,
  );
});

test("atomic transactions commit and roll back relationship edges, attachments, and history together", async () => {
  const f = await fixture();
  const company = await insertRecord(
    f.db,
    f.orgId,
    "companies",
    { name: "Acme" },
    f.admin.userId,
  );
  const original = await insertRecord(
    f.db,
    f.orgId,
    "contacts",
    { name: "Original", documents: [] },
    f.admin.userId,
  );
  const file = await uploadAttachment(f, original.id);
  const record = await insertRecord(
    f.db,
    f.orgId,
    "contacts",
    { name: "Ada", documents: [] },
    f.admin.userId,
  );
  const service = createTransactionService(
    f.db,
    postgresUrl ? "postgresql" : "sqlite",
  );
  const history = await f.db.recordHistory.count({
    where: { recordId: record.id },
  });
  const update = {
    op: "record.update" as const,
    collection: "contacts",
    id: record.id,
    data: { company: company.id, documents: [file.id] },
  };
  await expect(
    service.execute(f.admin, {
      operations: [
        update,
        {
          op: "record.create",
          collection: "contacts",
          data: { company: "missing" },
        },
      ],
    }),
  ).rejects.toThrow("unavailable");
  expect(
    await f.db.recordReference.count({ where: { sourceId: record.id } }),
  ).toBe(0);
  expect(
    await f.db.recordAttachment.count({ where: { recordId: record.id } }),
  ).toBe(0);
  expect(
    await f.db.recordHistory.count({ where: { recordId: record.id } }),
  ).toBe(history);
  await service.execute(f.admin, { operations: [update] });
  expect(
    await f.db.recordReference.count({
      where: { sourceId: record.id, targetId: company.id },
    }),
  ).toBe(1);
  expect(
    await f.db.recordAttachment.count({
      where: { recordId: record.id, fileId: file.id },
    }),
  ).toBe(1);
  expect(
    await f.db.recordHistory.count({ where: { recordId: record.id } }),
  ).toBe(history + 1);
  await service.execute(f.admin, {
    operations: [
      {
        op: "record.update",
        collection: "contacts",
        id: record.id,
        data: { company: null },
      },
      { op: "record.delete", collection: "companies", id: company.id },
    ],
  });
  expect(
    await f.db.record.findUnique({ where: { id: company.id } }),
  ).toBeNull();
});

test("contextual uploads need record-field authority, remain private to the record, and pin bytes in history", async () => {
  const f = await fixture();
  const record = await insertRecord(
    f.db,
    f.orgId,
    "contacts",
    { name: "Deal", visible: true, documents: [] },
    f.admin.userId,
  );
  await addPolicy(
    f.db,
    f.orgId,
    f.reader.userId,
    "/collections/contacts",
    "read",
    { where: { visible: true }, fields: ["name", "documents"] },
  );
  await addPolicy(
    f.db,
    f.orgId,
    f.reader.userId,
    "/collections/contacts",
    "write",
    { where: { visible: true }, fields: ["documents"] },
  );
  const file = await uploadAttachment(f, record.id, f.reader);
  expect(await listFiles(f.db, f.orgId)).toEqual([]);
  const loaded = await f
    .appFor(f.reader)
    .request(`/collections/contacts/records/${record.id}`);
  expect(loaded.status).toBe(200);
  expect((await loaded.json()).attachments.documents).toMatchObject([
    { id: file.id, filename: "contract.txt" },
  ]);
  const link = await createDownloadLink(
    f.services,
    f.config,
    f.orgId,
    f.reader.userId,
    file.id,
  );
  expect(
    await (
      await downloadLocalFile(
        f.services,
        f.config,
        file.id,
        new URL(link.download_url).searchParams.get("token")!,
      )
    ).text(),
  ).toBe("hello");
  await expect(deleteFile(f.db, f.orgId, file.id)).rejects.toThrow("retained");
  await updateRecord(
    f.db,
    f.orgId,
    "contacts",
    record.id,
    { documents: [] },
    null,
    null,
    undefined,
    f.admin.userId,
  );
  const history = await queryRecordHistory(f.db, f.reader, "contacts", {
    record_id: record.id,
  });
  expect(
    history.items.some((item) => JSON.stringify(item.before).includes(file.id)),
  ).toBe(true);
  expect(
    (
      await createDownloadLink(
        f.services,
        f.config,
        f.orgId,
        f.reader.userId,
        file.id,
      )
    ).file.id,
  ).toBe(file.id);
  await expect(deleteFile(f.db, f.orgId, file.id)).rejects.toThrow("retained");
  await f.db.recordHistory.updateMany({
    where: { orgId: f.orgId },
    data: { createdAt: new Date(0) },
  });
  await pruneRecordHistory(f.db);
  await expect(
    createDownloadLink(f.services, f.config, f.orgId, f.reader.userId, file.id),
  ).rejects.toThrow();
  await deleteFile(f.db, f.orgId, file.id);
});

test("file-library permissions cannot expose private attachments and upload completion rechecks destination authority", async () => {
  const f = await fixture();
  const record = await insertRecord(
    f.db,
    f.orgId,
    "contacts",
    { name: "Private", documents: [] },
    f.admin.userId,
  );
  const file = await uploadAttachment(f, record.id);
  await addPolicy(f.db, f.orgId, f.reader.userId, "/files", "*");
  await addPolicy(
    f.db,
    f.orgId,
    f.reader.userId,
    "/collections/contacts",
    "read",
    { fields: ["name"] },
  );
  const visible = await f
    .appFor(f.reader)
    .request(`/collections/contacts/records/${record.id}`);
  expect((await visible.json()).attachments).toBeUndefined();
  expect((await f.appFor(f.reader).request(`/files/${file.id}`)).status).toBe(
    404,
  );
  expect(
    (await f.appFor(f.reader).request(`/files/${file.id}/content`)).status,
  ).toBe(404);
  expect(
    (
      await f
        .appFor(f.reader)
        .request(`/files/${file.id}`, { method: "DELETE" })
    ).status,
  ).toBe(409);
  expect(await f.storage.stat(`${f.orgId}/${file.id}`)).not.toBeNull();
  const attachment = {
    collection: "contacts",
    record_id: record.id,
    field: "documents",
  };
  await expect(
    createUpload(f.services, f.config, f.orgId, f.reader.userId, attachment),
  ).rejects.toThrow();
  const session = await createUpload(
    f.services,
    f.config,
    f.orgId,
    f.admin.userId,
    attachment,
  );
  await prepareUpload(f.services, f.config, session.upload, session.token, {
    filename: "second.txt",
    size_bytes: 5,
  });
  const prepared = await getUpload(f.services, session.upload.id, {
    token: session.token,
  });
  await writeUpload(f.services, prepared, new Blob(["hello"]).stream());
  await deleteRecord(f.db, f.orgId, "contacts", record.id);
  await expect(completeUpload(f.services, prepared)).rejects.toThrow();
  expect(
    await f.db.file.findUnique({ where: { id: session.upload.id } }),
  ).toBeNull();
});

test("REST reference query and reverse lookup share the authorized service behavior", async () => {
  const f = await fixture();
  const company = await insertRecord(
    f.db,
    f.orgId,
    "companies",
    { name: "Acme" },
    f.admin.userId,
  );
  await insertRecord(
    f.db,
    f.orgId,
    "contacts",
    { name: "Ada", company: company.id },
    f.admin.userId,
  );
  const app = f.appFor();
  const response = await app.request("/collections/contacts/records/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      where: { company: { some: { name: "Acme" } } },
      expand: ["company"],
    }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).records[0].expand.company.data.name).toBe(
    "Acme",
  );
  const reverse = await app.request(
    `/collections/companies/records/${company.id}/related`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_collection: "contacts", field: "company" }),
    },
  );
  expect(reverse.status).toBe(200);
  expect((await reverse.json()).total).toBe(1);
});

test("MCP uploads and reads attachments using destination-field access", async () => {
  const f = await fixture();
  const record = await insertRecord(
    f.db,
    f.orgId,
    "contacts",
    { name: "Deal", documents: [] },
    f.admin.userId,
  );
  await addPolicy(
    f.db,
    f.orgId,
    f.reader.userId,
    "/collections/contacts",
    "read",
    { fields: ["name", "documents"] },
  );
  await addPolicy(
    f.db,
    f.orgId,
    f.reader.userId,
    "/collections/contacts",
    "update",
    { fields: ["documents"] },
  );
  const server = new McpServer({ name: "attachment-test", version: "1.0.0" });
  const context = { ...f.reader, services: f.services, config: f.config };
  registerDataTools(server, context);
  registerOperationsTools(server, context);
  const client = new Client({ name: "attachment-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const prepared = await client.callTool({
    name: "files_prepare_upload",
    arguments: {
      filename: "contract.txt",
      size_bytes: 5,
      attachment: {
        collection: "contacts",
        record_id: record.id,
        field: "documents",
      },
    },
  });
  expect(prepared.isError).not.toBe(true);
  const input = prepared.structuredContent as {
    upload_id: string;
    headers: Record<string, string>;
  };
  const upload = await getUpload(f.services, input.upload_id, {
    token: input.headers.Authorization!.replace(/^Bearer /, ""),
  });
  await writeUpload(f.services, upload, new Blob(["hello"]).stream());
  const completed = await client.callTool({
    name: "files_complete_upload",
    arguments: { upload_id: input.upload_id },
  });
  expect(completed.isError).not.toBe(true);
  const loaded = await client.callTool({
    name: "records_get",
    arguments: { collection: "contacts", id: record.id },
  });
  expect(loaded.structuredContent).toMatchObject({
    attachments: {
      documents: [{ id: input.upload_id, filename: "contract.txt" }],
    },
  });
  const downloaded = await client.callTool({
    name: "files_download_link",
    arguments: { id: input.upload_id },
  });
  expect(downloaded.isError).not.toBe(true);
  expect(downloaded.structuredContent).toMatchObject({
    file: { id: input.upload_id },
  });
  await addPolicy(f.db, f.orgId, f.reader.userId, "/files", "delete");
  const pinned = await client.callTool({
    name: "files_delete",
    arguments: { id: input.upload_id, confirm: true },
  });
  expect(pinned.structuredContent).toMatchObject({
    error: "RelationshipConflictError",
  });
  await client.callTool({
    name: "records_update",
    arguments: {
      collection: "contacts",
      id: record.id,
      data: { documents: [] },
    },
  });
  await f.db.recordHistory.updateMany({
    where: { orgId: f.orgId },
    data: { createdAt: new Date(0) },
  });
  await pruneRecordHistory(f.db);
  const removed = await client.callTool({
    name: "files_delete",
    arguments: { id: input.upload_id, confirm: true },
  });
  expect(removed.isError).not.toBe(true);
  expect(await f.storage.stat(`${f.orgId}/${input.upload_id}`)).toBeNull();
});

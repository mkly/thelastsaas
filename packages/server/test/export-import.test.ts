import { afterEach, describe, expect, test } from "bun:test";
import type { ExportData } from "@lastsaas/shared";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createQueueEnqueueService } from "../src/queues/enqueue";
import { exportData, importData } from "../src/db/export-import";
import { roleSubject } from "../src/db/casbin";
import type { AppEnvironment } from "../src/env";
import { systemRouter } from "../src/routes/system";
import { loadConfig } from "../src/config";
import { closeServices, createServices } from "../src/services";
import { testMigrationSql } from "./test-migrations";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createExportServices() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-export-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
  });
  const services = await createServices(config);
  if (!services.database) throw new Error("Expected SQLite database handle");
  services.database.exec(testMigrationSql);
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  return services;
}

function createSystemApp(
  services: Awaited<ReturnType<typeof createExportServices>>,
  orgId: string,
  userId: string,
) {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (context, next) => {
    context.set("services", services);
    context.set("orgId", orgId);
    context.set("userId", userId);
    context.set("audit", async () => undefined);
    await next();
  });
  app.route("/v1/orgs/:orgId", systemRouter);
  return app;
}

function canonicalize(data: ExportData): ExportData {
  const recordIds = new Map<string, string>();
  for (const collection of data.collections) {
    collection.records.forEach((record, index) => {
      recordIds.set(record.id, `${collection.name}:record:${index}`);
      record.id = `${collection.name}:record:${index}`;
    });
  }
  data.files.forEach((file) => {
    file.id = `file:${file.path}`;
    file.record_id = file.record_id
      ? (recordIds.get(file.record_id) ?? file.record_id)
      : null;
  });
  data.notification_schedules.forEach((schedule) => {
    schedule.id = `schedule:${schedule.dedupe_key}`;
    schedule.status = "paused";
  });
  return data;
}

describe("organization export and import", () => {
  test("requires manage rights and round-trips every portable org primitive", async () => {
    const services = await createExportServices();
    const { prisma } = services;
    const createdAt = new Date("2026-08-18T20:00:00.000Z");
    const updatedAt = new Date("2026-08-18T21:00:00.000Z");
    const sourceOrg = "org_source";
    const destinationOrg = "org_destination";
    const owner = "user_owner";
    const reader = "user_reader";

    await prisma.user.createMany({
      data: [
        { id: owner, email: "owner@example.com", name: "Owner" },
        { id: reader, email: "reader@example.com", name: "Reader" },
      ],
    });
    await prisma.organization.createMany({
      data: [
        { id: sourceOrg, name: "Source", slug: "source" },
        { id: destinationOrg, name: "Destination", slug: "destination" },
      ],
    });
    await prisma.member.createMany({
      data: [
        {
          id: "member_source_owner",
          organizationId: sourceOrg,
          userId: owner,
          role: "admin",
        },
        {
          id: "member_source_reader",
          organizationId: sourceOrg,
          userId: reader,
        },
        {
          id: "member_destination_owner",
          organizationId: destinationOrg,
          userId: owner,
          role: "admin",
        },
      ],
    });

    for (const orgId of [sourceOrg, destinationOrg]) {
      await prisma.casbinRule.createMany({
        data: [
          {
            orgId,
            ptype: "p",
            v0: roleSubject(orgId, "admin"),
            v1: "/*",
            v2: "*",
          },
          {
            orgId,
            ptype: "g",
            v0: owner,
            v1: roleSubject(orgId, "admin"),
          },
        ],
      });
    }
    await prisma.casbinRule.createMany({
      data: [
        {
          orgId: sourceOrg,
          ptype: "p",
          v0: roleSubject(sourceOrg, "reader"),
          v1: "/collections/tasks",
          v2: "read",
        },
        {
          orgId: sourceOrg,
          ptype: "g",
          v0: reader,
          v1: roleSubject(sourceOrg, "reader"),
        },
        {
          orgId: sourceOrg,
          ptype: "p",
          v0: reader,
          v1: "/collections/tasks",
          v2: "write",
        },
      ],
    });

    await prisma.collection.create({
      data: {
        id: "collection_source",
        orgId: sourceOrg,
        name: "tasks",
        schema: { title: "string", owner: "string" },
        description: "Portable work",
      },
    });
    await prisma.record.create({
      data: {
        id: "record_source",
        orgId: sourceOrg,
        collectionId: "collection_source",
        data: { title: "Ship export", owner },
        createdBy: owner,
        createdAt,
        updatedAt,
      },
    });
    await prisma.rowFilter.create({
      data: {
        id: "row_filter_source",
        orgId: sourceOrg,
        collectionId: "collection_source",
        role: "reader",
        action: "read",
        condition: { owner: "$user.id" },
        createdAt,
        updatedAt,
      },
    });
    await prisma.fieldFilter.create({
      data: {
        id: "field_filter_source",
        orgId: sourceOrg,
        collectionId: "collection_source",
        role: "reader",
        action: "read",
        readableFields: ["title"],
        writableFields: [],
        createdAt,
        updatedAt,
      },
    });
    await prisma.file.create({
      data: {
        id: "file_source",
        orgId: sourceOrg,
        path: "tasks/spec.txt",
        filename: "spec.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
        collectionId: "collection_source",
        recordId: "record_source",
        uploadedBy: owner,
        createdAt,
        updatedAt,
      },
    });
    await prisma.notificationSchedule.create({
      data: {
        id: "schedule_source",
        orgId: sourceOrg,
        userId: owner,
        dedupeKey: "weekly-tasks",
        type: "task_digest",
        message: "Review your tasks",
        data: { collection: "tasks" },
        inApp: true,
        channel: "console",
        recurrence: "DTSTART:20260824T090000Z\nRRULE:FREQ=WEEKLY;COUNT=4",
        nextOccurrenceAt: new Date("2026-08-24T09:00:00.000Z"),
        status: "scheduled",
        createdAt,
        updatedAt,
      },
    });

    const denied = await createSystemApp(services, sourceOrg, reader).request(
      `/v1/orgs/${sourceOrg}/export`,
      { method: "POST" },
    );
    expect(denied.status).toBe(403);

    const sourceResponse = await createSystemApp(
      services,
      sourceOrg,
      owner,
    ).request(`/v1/orgs/${sourceOrg}/export`, { method: "POST" });
    expect(sourceResponse.status).toBe(200);
    const { status: sourceStatus, ...sourceData } =
      (await sourceResponse.json()) as {
        status: "ok";
      } & ExportData;
    expect(sourceStatus).toBe("ok");
    expect(Object.keys(sourceData).sort()).toEqual(
      [
        "collections",
        "field_filters",
        "files",
        "notification_schedules",
        "policies",
        "role_assignments",
        "row_filters",
        "version",
        "queues",
        "queue_subscriptions",
        "queue_schedules",
        "collection_triggers",
      ].sort(),
    );

    const importResponse = await createSystemApp(
      services,
      destinationOrg,
      owner,
    ).request(`/v1/orgs/${destinationOrg}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sourceData),
    });
    expect(importResponse.status).toBe(200);
    expect(await importResponse.json()).toMatchObject({
      status: "ok",
      imported_collections: 1,
      imported_records: 1,
      imported_files: 1,
      imported_policies: 2,
      imported_role_assignments: 1,
      imported_row_filters: 1,
      imported_field_filters: 1,
      imported_notification_schedules: 1,
    });

    const destinationResponse = await createSystemApp(
      services,
      destinationOrg,
      owner,
    ).request(`/v1/orgs/${destinationOrg}/export`, { method: "POST" });
    const { status: destinationStatus, ...destinationData } =
      (await destinationResponse.json()) as { status: "ok" } & ExportData;
    expect(destinationStatus).toBe("ok");
    expect(canonicalize(structuredClone(destinationData))).toEqual(
      canonicalize(structuredClone(sourceData)),
    );
  });

  test("rejects a dump whose collection schema is invalid with 400", async () => {
    const services = await createExportServices();
    const { prisma } = services;
    const orgId = "org_invalid";
    const owner = "user_invalid_owner";

    await prisma.user.create({
      data: { id: owner, email: "invalid@example.com", name: "Owner" },
    });
    await prisma.organization.create({
      data: { id: orgId, name: "Invalid", slug: "invalid" },
    });
    await prisma.member.create({
      data: {
        id: "member_invalid_owner",
        organizationId: orgId,
        userId: owner,
        role: "admin",
      },
    });
    await prisma.casbinRule.createMany({
      data: [
        {
          orgId,
          ptype: "p",
          v0: roleSubject(orgId, "admin"),
          v1: "/*",
          v2: "*",
        },
        { orgId, ptype: "g", v0: owner, v1: roleSubject(orgId, "admin") },
      ],
    });

    const response = await createSystemApp(services, orgId, owner).request(
      `/v1/orgs/${orgId}/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          collections: [
            {
              name: "tasks",
              schema: { title: "not_a_real_type" },
              description: "",
              records: [],
            },
          ],
          files: [],
          policies: [],
          role_assignments: [],
          row_filters: [],
          field_filters: [],
          notification_schedules: [],
        } satisfies ExportData),
      },
    );

    expect(response.status).toBe(400);
    expect(await prisma.collection.count({ where: { orgId } })).toBe(0);
  });
});

async function automationFixture() {
  const services = await createExportServices();
  const db = services.prisma;
  const now = new Date("2026-10-01T00:00:00.000Z");
  await db.organization.createMany({
    data: [
      { id: "source", name: "Source", slug: "automation-source" },
      {
        id: "destination",
        name: "Destination",
        slug: "automation-destination",
      },
    ],
  });
  await db.user.create({
    data: { id: "producer", name: "Producer", email: "automation@example.com" },
  });
  await db.collection.create({
    data: {
      id: "source-collection",
      orgId: "source",
      name: "jobs",
      schema: { title: "string" },
    },
  });
  await db.queue.create({
    data: {
      id: "source-queue",
      orgId: "source",
      name: "work",
      schema: { title: "string" },
      schemaVersion: 2,
    },
  });
  await db.queueSubscription.create({
    data: {
      id: "source-subscription",
      queueId: "source-queue",
      name: "workers",
      maxAttempts: 5,
    },
  });
  await db.member.createMany({
    data: [
      { id: "source-member", organizationId: "source", userId: "producer" },
      {
        id: "destination-member",
        organizationId: "destination",
        userId: "producer",
      },
    ],
  });
  await db.casbinRule.create({
    data: {
      orgId: "source",
      ptype: "p",
      v0: "producer",
      v1: "/queues/work",
      v2: "create",
    },
  });
  await createQueueEnqueueService(db).enqueue(
    {
      orgId: "source",
      userId: "producer",
      userEmail: "automation@example.com",
    },
    "work",
    {
      entries: [
        {
          payload: { title: "Ship" },
          idempotency_key: "job-1",
          available_at: now.toISOString(),
        },
      ],
    },
  );
  await db.queueSchedule.create({
    data: {
      id: "source-schedule",
      orgId: "source",
      createdBy: "producer",
      queueId: "source-queue",
      payload: { title: "Ship" },
      deliverAt: now,
      cursorAt: now,
      nextOccurrenceAt: now,
    },
  });
  await db.collectionTrigger.create({
    data: {
      id: "source-trigger",
      orgId: "source",
      createdBy: "producer",
      collectionId: "source-collection",
      queueId: "source-queue",
      events: ["create", "update"],
      watchedFields: ["title"],
      where: { title: { contains: "Ship" } },
      mapping: { title: { kind: "after", field: "title" } },
    },
  });
  await db.casbinRule.createMany({
    data: [
      {
        orgId: "source",
        ptype: "p",
        v0: "producer",
        v1: "/schedules/source-schedule",
        v2: "update",
      },
      {
        orgId: "source",
        ptype: "p",
        v0: "producer",
        v1: "/triggers/source-trigger",
        v2: "update",
      },
      {
        orgId: "source",
        ptype: "p",
        v0: "producer",
        v1: "/queues/work",
        v2: "read",
      },
    ],
  });
  return { services, db, dump: await exportData(db, "source") };
}

describe("automation configuration portability", () => {
  test("round trips queue settings and restores paused producers with remapped references", async () => {
    const { db, dump } = await automationFixture();
    const result = await importData(db, "destination", dump);
    expect(result).toMatchObject({
      imported_queues: 1,
      imported_queue_subscriptions: 1,
      imported_queue_schedules: 1,
      imported_collection_triggers: 1,
    });
    const queue = await db.queue.findFirstOrThrow({
      where: { orgId: "destination" },
      include: { subscriptions: true },
    });
    expect(queue.schema).toEqual({ title: "string" });
    expect(queue.subscriptions[0]!.maxAttempts).toBe(5);
    const schedule = await db.queueSchedule.findFirstOrThrow({
      where: { orgId: "destination" },
    });
    const trigger = await db.collectionTrigger.findFirstOrThrow({
      where: { orgId: "destination" },
    });
    expect(schedule.queueId).toBe(queue.id);
    expect(trigger.queueId).toBe(queue.id);
    expect(schedule.status).toBe("paused");
    expect(trigger.status).toBe("paused");
  });
  test("rolls back an import when a producer cannot be restored", async () => {
    const { db, dump } = await automationFixture();
    dump.queue_schedules![0]!.created_by = "missing-user";
    await expect(importData(db, "destination", dump)).rejects.toThrow(
      "Backup producer user is unavailable",
    );
    expect(await db.queue.count({ where: { orgId: "destination" } })).toBe(0);
  });
});

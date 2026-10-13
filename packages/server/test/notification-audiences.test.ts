import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config";
import {
  addPolicy,
  assignRole,
  removePolicy,
  roleSubject,
  unassignRole,
} from "../src/db/casbin";
import {
  queueNotifications,
  getNotifications,
  markNotificationRead,
} from "../src/db/notifications";
import {
  createNotificationSchedule,
  listNotificationSchedules,
  cancelNotificationSchedule,
} from "../src/db/notification-schedules";
import { exportData, importData } from "../src/db/export-import";
import { registerOperationsTools } from "../src/mcp/tools/operations";
import { NotificationDispatcher } from "../src/notifications/channels";
import { NotificationQueue } from "../src/notifications/queue";
import { NotificationScheduleProcessor } from "../src/scheduler";
import { createServices, closeServices } from "../src/services";
import { notificationRouter } from "../src/routes/notifications";
import { notificationScheduleRouter } from "../src/routes/notification-schedules";
import type { AppEnvironment } from "../src/env";
import { testMigrationSql } from "./test-migrations";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// This contract runs on SQLite normally and on the PostgreSQL runner's isolated schema.
async function fixture() {
  const directory = mkdtempSync(
    join(tmpdir(), "lastsaas-notification-audiences-"),
  );
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL:
      process.env.QUERY_TEST_DATABASE_URL ??
      `file:${join(directory, "test.db")}`,
    STORAGE_PATH: join(directory, "files"),
  });
  const services = await createServices(config);
  services.database?.exec(testMigrationSql);
  const prisma = services.prisma;
  const orgId = crypto.randomUUID();
  await prisma.organization.create({
    data: { id: orgId, name: "Notification team", slug: orgId },
  });
  const people = await Promise.all(
    ["sender", "alice", "bob", "eve", "bot", "outsider"].map((name) =>
      prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          name,
          email: `${name}-${orgId}@example.com`,
          kind: name === "bot" ? "service" : "human",
        },
      }),
    ),
  );
  const [sender, alice, bob, eve, bot, outsider] = people;
  if (!sender || !alice || !bob || !eve || !bot || !outsider)
    throw new Error("Missing fixture user");
  await prisma.member.createMany({
    data: people
      .filter((user) => user.id !== outsider.id)
      .map((user) => ({
        id: crypto.randomUUID(),
        organizationId: orgId,
        userId: user.id,
      })),
  });
  await assignRole(prisma, orgId, alice.id, "engineering");
  await assignRole(prisma, orgId, bob.id, "engineering");
  await assignRole(prisma, orgId, bob.id, "support");
  await assignRole(prisma, orgId, bot.id, "engineering");
  await addPolicy(
    prisma,
    orgId,
    sender.id,
    "/notifications/roles/engineering",
    "write",
  );
  const email = mock().mockResolvedValue(true);
  const queue = new NotificationQueue(
    prisma,
    new NotificationDispatcher([
      { name: "email", send: email },
      { name: "console", send: async () => true },
    ]),
  );
  services.notificationQueue = queue;
  const processor = new NotificationScheduleProcessor(prisma, queue);
  cleanups.push(async () => {
    await prisma.notification.deleteMany({ where: { orgId } });
    await prisma.notificationSchedule.deleteMany({ where: { orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.user.deleteMany({
      where: { id: { in: people.map((user) => user.id) } },
    });
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    services,
    config,
    prisma,
    orgId,
    sender,
    alice,
    bob,
    eve,
    bot,
    outsider,
    email,
    queue,
    processor,
  };
}

describe("notification audiences", () => {
  test("concurrent retries create one delivery per recipient without replacing content", async () => {
    const { prisma, queue, orgId, sender } = await fixture();
    const input = {
      subject: "First content",
      audience: { kind: "roles" as const, roles: ["engineering"] },
      dedupeKey: "concurrent-team-request",
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        queueNotifications(prisma, queue, orgId, sender.id, input),
      ),
    );
    for (const result of results) expect(result.ids).toEqual(results[0]!.ids);
    await queueNotifications(prisma, queue, orgId, sender.id, {
      ...input,
      subject: "Replacement",
    });
    const rows = await prisma.notification.findMany({ where: { orgId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.message === "First content")).toBe(true);
  });

  test("unknown roles are rejected and immediate fanout is atomic", async () => {
    const { prisma, queue, orgId, sender } = await fixture();
    await expect(
      queueNotifications(prisma, queue, orgId, sender.id, {
        subject: "Typo",
        audience: { kind: "roles", roles: ["enginering"] },
      }),
    ).rejects.toThrow("Every selected role must exist");
    const enqueue = queue.enqueue.bind(queue);
    let writes = 0;
    queue.enqueue = async (...args) => {
      if (++writes === 2) throw new Error("Fanout interrupted");
      return enqueue(...args);
    };
    await expect(
      queueNotifications(prisma, queue, orgId, sender.id, {
        subject: "Atomic",
        audience: { kind: "roles", roles: ["engineering"] },
      }),
    ).rejects.toThrow("Fanout interrupted");
    expect(await prisma.notification.count({ where: { orgId } })).toBe(0);
  });

  test("delivery failures retry independently per recipient", async () => {
    const { prisma, queue, orgId, sender, alice, bob, email } = await fixture();
    email.mockImplementation(async (message) => message.to !== alice.email);
    await queueNotifications(prisma, queue, orgId, sender.id, {
      subject: "Retry",
      audience: { kind: "roles", roles: ["engineering"] },
    });
    const now = new Date(Date.now() + 1000);
    await queue.processDue(now);
    expect(
      await prisma.notification.findFirstOrThrow({
        where: { orgId, userId: alice.id },
      }),
    ).toMatchObject({
      status: "pending",
      channelResults: { failed: ["email"], succeeded: ["console"] },
    });
    expect(
      await prisma.notification.findFirstOrThrow({
        where: { orgId, userId: bob.id },
      }),
    ).toMatchObject({
      status: "sent",
      channelResults: { failed: [], succeeded: ["email", "console"] },
    });
  });

  test("role and user audiences deduplicate recipients and direct requests use destination role grants", async () => {
    const { prisma, queue, orgId, sender, alice, bob } = await fixture();
    const roles = await queueNotifications(prisma, queue, orgId, sender.id, {
      subject: "Team",
      audience: {
        kind: "roles",
        roles: ["engineering", "support", "engineering"],
      },
      dedupeKey: "team-1",
    });
    expect(roles.recipient_count).toBe(2);
    expect(roles.ids).toHaveLength(2);
    const users = await queueNotifications(prisma, queue, orgId, sender.id, {
      subject: "Team",
      audience: { kind: "users", users: [alice.email, alice.id, bob.id] },
      dedupeKey: "team-1",
    });
    expect(users.ids).toEqual(roles.ids);
    await addPolicy(
      prisma,
      orgId,
      bob.id,
      "/notifications/roles/engineering",
      "write",
    );
    await queueNotifications(prisma, queue, orgId, bob.id, {
      subject: "Another sender",
      audience: { kind: "users", users: [alice.id] },
      dedupeKey: "team-1",
    });
    expect(
      await prisma.notification.count({ where: { orgId, userId: alice.id } }),
    ).toBe(2);
  });

  test("rejects unauthorized or outside-organization recipients before writing any deliveries", async () => {
    const { prisma, queue, orgId, sender, alice, eve, outsider, bot } =
      await fixture();
    await expect(
      queueNotifications(prisma, queue, orgId, sender.id, {
        subject: "Mixed",
        audience: { kind: "users", users: [alice.id, eve.email] },
      }),
    ).rejects.toThrow("Not permitted");
    for (const reference of [
      outsider.id,
      outsider.email,
      bot.id,
      "missing@example.com",
    ]) {
      await expect(
        queueNotifications(prisma, queue, orgId, sender.id, {
          subject: "Mixed",
          audience: { kind: "users", users: [alice.id, reference] },
        }),
      ).rejects.toThrow("human member");
    }
    expect(await prisma.notification.count({ where: { orgId } })).toBe(0);
    await addPolicy(
      prisma,
      orgId,
      sender.id,
      `/notifications/users/${eve.id}`,
      "write",
    );
    expect(
      (
        await queueNotifications(prisma, queue, orgId, sender.id, {
          subject: "Specific",
          audience: { kind: "users", users: [eve.email] },
        })
      ).recipient_count,
    ).toBe(1);
  });

  test("all reaches human members only, with separate read state and creator attribution", async () => {
    const { prisma, queue, orgId, alice, bob, bot } = await fixture();
    // Service accounts can send through a custom role but never receive team notifications.
    await assignRole(prisma, orgId, bot.id, "announcer");
    await addPolicy(
      prisma,
      orgId,
      roleSubject(orgId, "announcer"),
      "/notifications/*",
      "write",
    );
    const result = await queueNotifications(prisma, queue, orgId, bot.id, {
      subject: "Everyone",
      audience: { kind: "all" },
    });
    expect(result).toMatchObject({ id: null, recipient_count: 4 });
    expect(
      await prisma.notification.count({ where: { orgId, userId: bot.id } }),
    ).toBe(0);
    const aliceRows = await getNotifications(prisma, orgId, alice.id, false);
    expect(aliceRows[0]?.created_by).toBe(bot.id);
    expect(
      (
        await markNotificationRead(
          prisma,
          aliceRows[0]!.id,
          orgId,
          bob.id,
          true,
        )
      ).count,
    ).toBe(0);
    await markNotificationRead(prisma, aliceRows[0]!.id, orgId, alice.id, true);
    expect(
      (await getNotifications(prisma, orgId, bob.id, false))[0]?.read,
    ).toBe(false);
  });

  test("honors each recipient's channel preferences without sending opted-out email", async () => {
    const { prisma, queue, orgId, sender, alice, bob, eve, email } =
      await fixture();
    await addPolicy(prisma, orgId, sender.id, "/notifications/*", "write");
    await prisma.user.update({
      where: { id: alice.id },
      data: {
        notificationPreferences: { default: { in_app: true, email: false } },
      },
    });
    await prisma.user.update({
      where: { id: bob.id },
      data: {
        notificationPreferences: { default: { in_app: false, email: false } },
      },
    });
    await prisma.user.update({
      where: { id: eve.id },
      data: {
        notificationPreferences: { default: { in_app: false, email: true } },
      },
    });
    const result = await queueNotifications(prisma, queue, orgId, sender.id, {
      subject: "Email",
      audience: { kind: "users", users: [alice.id, bob.id, eve.id] },
    });
    expect(result).toMatchObject({
      recipient_count: 3,
      queued_count: 2,
      skipped_count: 1,
    });
    await queue.processDue(new Date(Date.now() + 1000));
    expect(email).toHaveBeenCalledTimes(1);
    expect(email.mock.calls[0]?.[0].to).toBe(eve.email);
    expect(await getNotifications(prisma, orgId, alice.id, false)).toHaveLength(
      1,
    );
    expect(await getNotifications(prisma, orgId, bob.id, false)).toHaveLength(
      0,
    );
    expect(await getNotifications(prisma, orgId, eve.id, false)).toHaveLength(
      0,
    );
  });

  test("recurring role audiences use current membership at each occurrence", async () => {
    const { prisma, orgId, sender, bob, eve, processor } = await fixture();
    const schedule = await createNotificationSchedule(
      prisma,
      orgId,
      sender.id,
      {
        subject: "Daily",
        message: "Daily",
        recurrence:
          "DTSTART;TZID=UTC:20261010T100000\nRRULE:FREQ=DAILY;COUNT=2",
        audience: { kind: "roles", roles: ["engineering"] },
      },
    );
    expect(await processor.processDue(new Date("2026-10-10T10:00:00Z"))).toBe(
      1,
    );
    await assignRole(prisma, orgId, eve.id, "engineering");
    await prisma.member.delete({
      where: {
        organizationId_userId: { organizationId: orgId, userId: bob.id },
      },
    });
    expect(await processor.processDue(new Date("2026-10-11T10:00:00Z"))).toBe(
      1,
    );
    expect(
      await prisma.notification.count({ where: { scheduleId: schedule.id } }),
    ).toBe(4);
    expect(
      await prisma.notification.count({
        where: { scheduleId: schedule.id, userId: eve.id },
      }),
    ).toBe(1);
    expect(await processor.processDue(new Date("2026-10-11T10:00:00Z"))).toBe(
      0,
    );
  });

  test("selected users are stored as IDs, use their current email, and skip departed members", async () => {
    const { prisma, orgId, sender, alice, bob, processor } = await fixture();
    const schedule = await createNotificationSchedule(
      prisma,
      orgId,
      sender.id,
      {
        subject: "Fixed",
        message: "Fixed",
        deliver_at: "2026-10-10T10:00:00Z",
        audience: { kind: "users", users: [alice.email, bob.id] },
      },
    );
    expect(schedule.audience).toEqual({
      kind: "users",
      users: [alice.id, bob.id].sort(),
    });
    await prisma.user.update({
      where: { id: alice.id },
      data: { email: `changed-${alice.id}@example.com` },
    });
    await prisma.member.delete({
      where: {
        organizationId_userId: { organizationId: orgId, userId: bob.id },
      },
    });
    await processor.processDue(new Date("2026-10-10T10:00:00Z"));
    const rows = await prisma.notification.findMany({
      where: { scheduleId: schedule.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(alice.id);
    expect(
      (rows[0]?.data as { __delivery: { to: string } }).__delivery.to,
    ).toBe(`changed-${alice.id}@example.com`);
  });

  test("revoked grants and malformed audiences cancel schedules and queued deliveries without blocking other schedules", async () => {
    const { prisma, queue, orgId, sender, bob, email, processor } =
      await fixture();
    const team = await createNotificationSchedule(prisma, orgId, sender.id, {
      subject: "Team",
      message: "Team",
      deliver_at: "2026-10-10T10:00:00Z",
      audience: { kind: "roles", roles: ["engineering"] },
    });
    await createNotificationSchedule(prisma, orgId, bob.id, {
      subject: "Self",
      message: "Self",
      deliver_at: "2026-10-10T10:00:00Z",
    });
    const malformed = await createNotificationSchedule(prisma, orgId, bob.id, {
      subject: "Malformed",
      message: "Malformed",
      deliver_at: "2026-10-10T10:00:00Z",
    });
    await prisma.notificationSchedule.update({
      where: { id: malformed.id },
      data: { audience: { kind: "everyone" } },
    });
    await queueNotifications(prisma, queue, orgId, sender.id, {
      subject: "Queued team",
      audience: { kind: "roles", roles: ["engineering"] },
    });
    await removePolicy(
      prisma,
      orgId,
      sender.id,
      "/notifications/roles/engineering",
      "write",
    );
    expect(await processor.processDue(new Date("2026-10-10T10:00:00Z"))).toBe(
      1,
    );
    expect(
      (
        await prisma.notificationSchedule.findUniqueOrThrow({
          where: { id: team.id },
        })
      ).status,
    ).toBe("cancelled");
    expect(
      (
        await prisma.notificationSchedule.findUniqueOrThrow({
          where: { id: malformed.id },
        })
      ).status,
    ).toBe("cancelled");
    await queue.processDue(new Date(Date.now() + 1000));
    expect(email).toHaveBeenCalledTimes(1);
    expect(email.mock.calls[0]![0].to).toBe(bob.email);
    expect(
      await prisma.notification.count({
        where: {
          orgId,
          createdByUserId: sender.id,
          status: "cancelled",
          inApp: false,
        },
      }),
    ).toBe(2);
  });

  test("queued team delivery rechecks role membership, preferences, and sender membership", async () => {
    const { prisma, queue, orgId, sender, alice, bob, email } = await fixture();
    await queueNotifications(prisma, queue, orgId, sender.id, {
      subject: "Queued",
      audience: { kind: "roles", roles: ["engineering"] },
    });
    await unassignRole(prisma, orgId, alice.id, "engineering");
    await prisma.user.update({
      where: { id: bob.id },
      data: {
        notificationPreferences: { default: { in_app: true, email: false } },
      },
    });
    await queue.processDue(new Date(Date.now() + 1000));
    expect(email).not.toHaveBeenCalled();
    expect(await getNotifications(prisma, orgId, alice.id, false)).toHaveLength(
      0,
    );
    await prisma.user.update({
      where: { id: bob.id },
      data: {
        notificationPreferences: { default: { in_app: true, email: true } },
      },
    });
    const leaving = await queueNotifications(prisma, queue, orgId, sender.id, {
      subject: "Sender leaving",
      audience: { kind: "users", users: [bob.id] },
    });
    await prisma.member.delete({
      where: {
        organizationId_userId: { organizationId: orgId, userId: sender.id },
      },
    });
    await queue.processDue(new Date(Date.now() + 1000));
    expect(email).not.toHaveBeenCalled();
    expect(
      await prisma.notification.findUniqueOrThrow({
        where: { id: leaving.id! },
      }),
    ).toMatchObject({ status: "cancelled", inApp: false });
  });

  test("failed fanout rolls back all recipient rows and the schedule cursor, then retries cleanly", async () => {
    const { prisma, queue, orgId, sender, processor } = await fixture();
    const schedule = await createNotificationSchedule(
      prisma,
      orgId,
      sender.id,
      {
        subject: "Atomic",
        message: "Atomic",
        deliver_at: "2026-10-10T10:00:00Z",
        audience: { kind: "roles", roles: ["engineering"] },
      },
    );
    let calls = 0;
    const broken = {
      enqueue: async (...args: Parameters<NotificationQueue["enqueue"]>) => {
        if (++calls === 2) throw new Error("Interrupted fanout");
        return queue.enqueue(...args);
      },
    };
    const failing = new NotificationScheduleProcessor(prisma, broken as never);
    await expect(
      failing.processDue(new Date("2026-10-10T10:00:00Z")),
    ).rejects.toThrow("Interrupted fanout");
    expect(
      await prisma.notification.count({ where: { scheduleId: schedule.id } }),
    ).toBe(0);
    expect(
      await prisma.notificationSchedule.findUniqueOrThrow({
        where: { id: schedule.id },
      }),
    ).toMatchObject({ status: "scheduled", lastEnqueuedAt: null });
    expect(await processor.processDue(new Date("2026-10-10T10:00:00Z"))).toBe(
      1,
    );
    expect(
      await prisma.notification.count({ where: { scheduleId: schedule.id } }),
    ).toBe(2);
  });

  test("the creator owns audience schedules and export/import retains their audience", async () => {
    const { prisma, orgId, sender, alice } = await fixture();
    const schedule = await createNotificationSchedule(
      prisma,
      orgId,
      sender.id,
      {
        subject: "Exported",
        message: "Exported",
        deliver_at: "2026-10-10T10:00:00Z",
        audience: { kind: "users", users: [alice.email] },
      },
    );
    expect(
      await listNotificationSchedules(prisma, orgId, alice.id),
    ).toHaveLength(0);
    expect(
      (await cancelNotificationSchedule(prisma, orgId, alice.id, schedule.id))
        .count,
    ).toBe(0);
    const data = await exportData(prisma, orgId);
    expect(data.notification_schedules[0]?.audience).toEqual({
      kind: "users",
      users: [alice.id],
    });
    await prisma.notificationSchedule.delete({ where: { id: schedule.id } });
    await importData(prisma, orgId, data);
    expect(
      (await listNotificationSchedules(prisma, orgId, sender.id))[0]?.audience,
    ).toEqual(schedule.audience);
    expect(
      (await cancelNotificationSchedule(prisma, orgId, sender.id, schedule.id))
        .count,
    ).toBe(1);
  });

  test("REST and MCP enforce the same destination authorization and normalize audiences", async () => {
    const { prisma, orgId, services, config, sender, alice, eve } =
      await fixture();
    const app = new Hono<AppEnvironment>();
    app.use("*", async (context, next) => {
      context.set("orgId", orgId);
      context.set("userId", sender.id);
      context.set("services", services);
      context.set("audit", async () => undefined);
      await next();
    });
    app.route("/notifications/schedules", notificationScheduleRouter);
    app.route("/notifications", notificationRouter);
    const request = (body: object) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(
      (
        await app.request(
          "/notifications/notify",
          request({
            subject: "No",
            audience: { kind: "users", users: [eve.id] },
          }),
        )
      ).status,
    ).toBe(403);
    const scheduled = await app.request(
      "/notifications/notify",
      request({
        subject: "Yes",
        message: "Yes",
        timing: { kind: "once", at: "2026-10-10T10:00:00Z" },
        audience: { kind: "users", users: [alice.email] },
      }),
    );
    expect(scheduled.status).toBe(201);
    expect(await scheduled.json()).toMatchObject({
      schedule: {
        audience: { kind: "users", users: [alice.id] },
        created_by: sender.id,
        recipient: alice.id,
      },
    });
    const server = new McpServer({ name: "audience-test", version: "1.0.0" });
    registerOperationsTools(server, {
      services,
      config,
      userId: sender.id,
      orgId,
    });
    const client = new Client({
      name: "audience-test-client",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const denied = await client.callTool({
        name: "notify",
        arguments: {
          subject: "No",
          audience: { kind: "users", users: [eve.email] },
        },
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        error: "PermissionDeniedError",
      });
      expect(await prisma.notification.count({ where: { orgId } })).toBe(0);
      const allowed = await client.callTool({
        name: "notify",
        arguments: {
          subject: "Yes",
          audience: { kind: "roles", roles: ["engineering"] },
        },
      });
      expect(allowed.isError).not.toBe(true);
      expect(allowed.structuredContent).toMatchObject({
        queued_count: 2,
        recipient_count: 2,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

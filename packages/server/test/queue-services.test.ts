import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createQueueTransportFixture } from "./queue-transport-helpers";
import { closeServices } from "../src/services";
import { createQueueConfigService } from "../src/queues/config";
import { createQueueSubscriptionService } from "../src/queues/subscriptions";
import { createQueueEnqueueService } from "../src/queues/enqueue";
import { createQueueClaimService } from "../src/queues/claim";
import { createQueueSettlementService } from "../src/queues/settle";
import { createQueueReadService } from "../src/queues/read";
import { subscriptionCreateSchema } from "@lastsaas/shared";
import { addPolicy, removePolicy } from "../src/db/casbin";
import { NotificationQueue } from "../src/notifications/queue";
import { NotificationDispatcher } from "../src/notifications/channels";
import { getNotifications } from "../src/db/notifications";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const admin = {
  orgId: "org_one",
  userId: "admin",
  userEmail: "admin@example.com",
};
const worker = { ...admin, userId: "reader", userEmail: "reader@example.com" };
async function fixture() {
  const f = await createQueueTransportFixture("queue-services-", false);
  cleanups.push(async () => {
    await closeServices(f.services);
    rmSync(f.directory, { recursive: true, force: true });
  });
  const db = f.services.prisma;
  const config = createQueueConfigService(db);
  const subscriptions = createQueueSubscriptionService(db);
  await config.create(admin, {
    name: "emails",
    schema: { department: "string", address: "string" },
    enabled: true,
  });
  for (const name of ["workers", "archive"])
    await subscriptions.createSubscription(
      admin,
      "emails",
      subscriptionCreateSchema.parse({ name, retry_delay_seconds: 0 }),
    );
  for (const action of ["read", "update"])
    await addPolicy(db, admin.orgId, worker.userId, "/queues/emails", action);
  await addPolicy(
    db,
    admin.orgId,
    worker.userId,
    "/queues/emails/subscriptions/workers",
    "update",
  );
  return {
    ...f,
    db,
    config,
    subscriptions,
    enqueue: createQueueEnqueueService(db),
    claim: createQueueClaimService(db),
    settle: createQueueSettlementService(db),
    read: createQueueReadService(db),
  };
}

test("queue-level permission grants complete jobs, subscriptions fan out, and idempotent publication keeps one entry", async () => {
  const f = await fixture();
  const input = {
    entries: [
      {
        payload: { department: "finance", address: "a@example.com" },
        idempotency_key: "email-1",
      },
    ],
  };
  const sent = await f.enqueue.enqueue(admin, "emails", input);
  expect(await f.enqueue.enqueue(admin, "emails", input)).toEqual(sent);
  expect(sent.delivery_count).toBe(2);
  const [claim] = (
    await f.claim.claim(worker, "emails", "workers", { limit: 10 })
  ).claims;
  expect(claim!.payload).toEqual(input.entries[0]!.payload);
  expect(
    (await f.read.listEntries(worker, "emails", { limit: 10 })).items[0]!
      .payload,
  ).toEqual(claim!.payload);
  await expect(
    f.claim.claim(worker, "emails", "archive", { limit: 1 }),
  ).rejects.toThrow();
  await expect(f.enqueue.enqueue(worker, "emails", input)).rejects.toThrow();
  await removePolicy(
    f.db,
    admin.orgId,
    worker.userId,
    "/queues/emails/subscriptions/workers",
    "update",
  );
  await expect(
    f.settle.ack(worker, "emails", claim!.delivery_id, {
      token: claim!.lease_token,
    }),
  ).rejects.toThrow();
  await addPolicy(
    f.db,
    admin.orgId,
    worker.userId,
    "/queues/emails/subscriptions/workers",
    "update",
  );
  expect(
    (
      await f.settle.ack(worker, "emails", claim!.delivery_id, {
        token: claim!.lease_token,
      })
    ).state,
  ).toBe("succeeded");
  expect(
    (await f.claim.claim(admin, "emails", "archive", { limit: 10 })).claims,
  ).toHaveLength(1);
});

test("REST validates publication and enforces organization and worker access", async () => {
  const f = await fixture();
  const request = (user: string, path: string, body: unknown) =>
    f.app.request(`/v1/orgs/org_one/queues/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": user },
      body: JSON.stringify(body),
    });
  expect(
    (
      await request("admin", "emails/entries", {
        entries: [{ payload: { department: 23 } }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("foreign", "emails/entries", {
        entries: [{ payload: { department: "a" } }],
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("admin", "emails/entries", {
        entries: [
          { payload: { department: "a", address: "full@example.com" } },
        ],
      })
    ).status,
  ).toBe(201);
  const response = await request(
    "reader",
    "emails/subscriptions/workers/claim",
    { limit: 1 },
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.claims[0].payload.address).toBe("full@example.com");
  const ack = await request(
    "reader",
    `emails/deliveries/${result.claims[0].delivery_id}/ack`,
    { token: result.claims[0].lease_token },
  );
  expect(ack.status).toBe(200);
});

test("notifications commit with their jobs, deliver channels, and preserve inbox/read state", async () => {
  const f = await fixture();
  const deliveries: string[] = [];
  const queue = new NotificationQueue(
    f.db,
    new NotificationDispatcher([
      {
        name: "email",
        send: async (message) => {
          deliveries.push(message.to);
          return true;
        },
      },
    ]),
  );
  const input = {
    orgId: admin.orgId,
    userId: admin.userId,
    type: "test",
    message: "Hello",
    dedupeKey: "hello",
    delivery: {
      to: admin.userEmail,
      subject: "Hello",
      text: "Hello",
      channels: ["email"],
    },
  };
  await expect(
    f.db.$transaction(async (tx) => {
      await queue.enqueue(input, tx);
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(await queue.processDue()).toBe(0);
  const id = await queue.enqueue(input);
  expect(await queue.enqueue(input)).toBe(id);
  await f.db.notification.update({ where: { id }, data: { read: true } });
  expect(await queue.processDue()).toBe(1);
  expect(deliveries).toEqual([admin.userEmail]);
  expect(
    (await getNotifications(f.db, admin.orgId, admin.userId, false))[0],
  ).toMatchObject({ id, read: true, message: "Hello" });
  expect(await queue.processDue()).toBe(0);
});

test("pending publication blocks deletion and native settlement enables configuration cleanup", async () => {
  const f = await fixture();
  const sent = await f.enqueue.enqueue(admin, "emails", {
    entries: [{ payload: { department: "a" } }],
  });
  await expect(f.config.delete(admin, "emails")).rejects.toThrow("unfinished");
  expect(
    (await f.read.listDeliveries(admin, "emails", { limit: 10 })).items,
  ).toHaveLength(2);
  for (const subscription of ["workers", "archive"]) {
    const [claim] = (
      await f.claim.claim(admin, "emails", subscription, { limit: 1 })
    ).claims;
    await f.settle.ack(admin, "emails", claim!.delivery_id, {
      token: claim!.lease_token,
    });
  }
  await f.config.delete(admin, "emails");
  expect(
    await f.db.queueEntry.findUnique({ where: { id: sent.entries[0]!.id } }),
  ).toBeNull();
});

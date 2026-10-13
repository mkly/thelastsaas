import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createQueueTransportFixture } from "./queue-transport-helpers";
import { closeServices } from "../src/services";
import { createQueueConfigService } from "../src/queues/config";
import { createQueueEnqueueService } from "../src/queues/enqueue";
import { createQueueClaimService } from "../src/queues/claim";
import { createQueueSettlementService } from "../src/queues/settle";
import { createQueueReadService } from "../src/queues/read";
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
  await config.create(admin, {
    name: "emails",
    schema: { department: "string", address: "string" },
    enabled: true,
    retry_delay_seconds: 0,
  });
  for (const action of ["read", "update"])
    await addPolicy(db, admin.orgId, worker.userId, "/queues/emails", action);
  return {
    ...f,
    appConfig: f.config,
    db,
    config,
    enqueue: createQueueEnqueueService(db),
    claim: createQueueClaimService(db),
    settle: createQueueSettlementService(db),
    read: createQueueReadService(db),
  };
}

test("workers compete directly for one job and current queue permissions govern settlement", async () => {
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
  expect(sent.jobs).toHaveLength(1);
  const [claim] = (await f.claim.claim(worker, "emails", { limit: 10 })).claims;
  expect(claim!.payload).toEqual(input.entries[0]!.payload);
  expect(
    (await f.read.listJobs(worker, "emails", { limit: 10 })).items[0]!.payload,
  ).toEqual(claim!.payload);
  expect(
    (await f.claim.claim(admin, "emails", { limit: 1 })).claims,
  ).toHaveLength(0);
  await expect(
    f.settle.ack(admin, "emails", claim!.job_id, { token: claim!.lease_token }),
  ).rejects.toThrow("no longer valid");
  await expect(f.enqueue.enqueue(worker, "emails", input)).rejects.toThrow();
  await removePolicy(
    f.db,
    admin.orgId,
    worker.userId,
    "/queues/emails",
    "update",
  );
  await expect(
    f.settle.ack(worker, "emails", claim!.job_id, {
      token: claim!.lease_token,
    }),
  ).rejects.toThrow();
  await addPolicy(f.db, admin.orgId, worker.userId, "/queues/emails", "update");
  expect(
    (
      await f.settle.ack(worker, "emails", claim!.job_id, {
        token: claim!.lease_token,
      })
    ).state,
  ).toBe("succeeded");
  expect(
    (await f.claim.claim(admin, "emails", { limit: 10 })).claims,
  ).toHaveLength(0);
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
      await request("admin", "emails/jobs", {
        entries: [{ payload: { department: 23 } }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("foreign", "emails/jobs", {
        entries: [{ payload: { department: "a" } }],
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("admin", "emails/jobs", {
        entries: [
          { payload: { department: "a", address: "full@example.com" } },
        ],
      })
    ).status,
  ).toBe(201);
  const response = await request("reader", "emails/claim", { limit: 1 });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.claims[0].payload.address).toBe("full@example.com");
  const ack = await request(
    "reader",
    `emails/jobs/${result.claims[0].job_id}/ack`,
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
    (await f.read.listJobs(admin, "emails", { limit: 10 })).items,
  ).toHaveLength(1);
  {
    const [claim] = (await f.claim.claim(admin, "emails", { limit: 1 })).claims;
    await f.settle.ack(admin, "emails", claim!.job_id, {
      token: claim!.lease_token,
    });
  }
  await f.config.delete(admin, "emails");
  expect(
    await f.db.queueEntry.findUnique({ where: { id: sent.jobs[0]!.id } }),
  ).toBeNull();
});

test("concurrent consumers get one lease; retries fence old tokens and redrive keeps the job ID", async () => {
  const f = await fixture();
  await f.config.update(admin, "emails", { max_attempts: 1 });
  const sent = await f.enqueue.enqueue(admin, "emails", {
    entries: [{ payload: { department: "ops" } }],
  });
  const competing = await Promise.all([
    f.claim.claim(admin, "emails", { limit: 1 }),
    f.claim.claim(worker, "emails", { limit: 1 }),
  ]);
  expect(competing.flatMap((result) => result.claims)).toHaveLength(1);
  const index = competing.findIndex((result) => result.claims.length);
  const principal = index === 0 ? admin : worker;
  const first = competing[index]!.claims[0]!;
  expect(first.job_id).toBe(sent.jobs[0]!.id);
  expect(first.lease_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const extended = await f.settle.extend(principal, "emails", first.job_id, {
    token: first.lease_token,
  });
  expect(Date.parse(extended.lease_expires_at!)).toBeGreaterThanOrEqual(
    Date.parse(first.lease_expires_at),
  );
  expect(
    (
      await f.settle.nack(principal, "emails", first.job_id, {
        token: first.lease_token,
      })
    ).state,
  ).toBe("dead");
  await f.settle.redrive(admin, "emails", first.job_id);
  const second = (await f.claim.claim(worker, "emails", { limit: 1 }))
    .claims[0]!;
  expect(second.job_id).toBe(first.job_id);
  expect(second.lease_token).not.toBe(first.lease_token);
  await expect(
    f.settle.ack(principal, "emails", first.job_id, {
      token: first.lease_token,
    }),
  ).rejects.toThrow();
  expect(
    (
      await f.settle.ack(worker, "emails", second.job_id, {
        token: second.lease_token,
      })
    ).state,
  ).toBe("succeeded");
});

test("queue managers can cancel jobs without seeing payloads or claim credentials", async () => {
  const f = await fixture();
  await removePolicy(
    f.db,
    admin.orgId,
    worker.userId,
    "/queues/emails",
    "read",
  );
  await addPolicy(f.db, admin.orgId, worker.userId, "/queues/emails", "manage");
  const sent = await f.enqueue.enqueue(admin, "emails", {
    entries: [{ payload: { department: "confidential" } }],
  });
  const result = await f.settle.cancel(worker, "emails", sent.jobs[0]!.id);
  expect(result.state).toBe("cancelled");
  expect(JSON.stringify(result)).not.toContain("confidential");
  expect(result).not.toHaveProperty("nativeClaimToken");
  expect(
    (await f.claim.claim(admin, "emails", { limit: 1 })).claims,
  ).toHaveLength(0);
});

test("MCP exposes direct claims and one job identity from publication through acknowledgement", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } =
    await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerQueueTools } = await import("../src/mcp/tools/queues");
  const { registerQueueJobTools } = await import("../src/mcp/tools/queue-jobs");
  const f = await fixture();
  const server = new McpServer({ name: "queue-test", version: "1.0.0" });
  const context = {
    services: f.services,
    config: f.appConfig,
    userId: admin.userId,
    orgId: admin.orgId,
  };
  registerQueueTools(server, context);
  registerQueueJobTools(server, context);
  const client = new Client({ name: "queue-worker", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("queues_jobs");
    expect(names.some((name) => name.includes("subscription"))).toBe(false);
    const sent = await client.callTool({
      name: "queues_enqueue",
      arguments: {
        queue: "emails",
        entries: [{ payload: { department: "operations" } }],
      },
    });
    expect(sent.isError).not.toBe(true);
    const id = (sent.structuredContent as { jobs: Array<{ id: string }> })
      .jobs[0]!.id;
    const claimed = await client.callTool({
      name: "queues_claim",
      arguments: { queue: "emails" },
    });
    expect(claimed.isError).not.toBe(true);
    const claim = (
      claimed.structuredContent as {
        claims: Array<{ job_id: string; lease_token: string }>;
      }
    ).claims[0]!;
    expect(claim.job_id).toBe(id);
    const ack = await client.callTool({
      name: "queues_ack",
      arguments: { queue: "emails", job_id: id, token: claim.lease_token },
    });
    expect(ack.isError).not.toBe(true);
    expect(ack.structuredContent).toMatchObject({
      job: { id, state: "succeeded" },
    });
    expect(JSON.stringify(ack.structuredContent)).not.toContain(
      claim.lease_token,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

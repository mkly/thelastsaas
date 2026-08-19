import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { AppEnvironment } from "../src/env";
import { requireCollectionPermission } from "../src/middleware/permission";
import { permissionRouter } from "../src/routes/permissions";

interface Rule {
  id: number;
  orgId: string;
  ptype: string;
  v0: string | null;
  v1: string | null;
  v2: string | null;
}

function createPrismaFixture() {
  let nextId = 4;
  const rules: Rule[] = [
    {
      id: 1,
      orgId: "org_123",
      ptype: "p",
      v0: "org:org_123:user:admin",
      v1: "/*",
      v2: "*",
    },
    {
      id: 2,
      orgId: "org_123",
      ptype: "g",
      v0: "user_admin",
      v1: "org:org_123:user:admin",
      v2: null,
    },
  ];
  const members = [
    { id: "member_admin", organizationId: "org_123", userId: "user_admin" },
    { id: "member_reader", organizationId: "org_123", userId: "user_reader" },
  ];
  const users = [
    { id: "user_admin", email: "admin@example.com" },
    { id: "user_reader", email: "reader@example.com" },
  ];

  const casbinRule = {
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const ptypes = (where.ptype as { in?: string[] } | undefined)?.in;
      return rules.filter(
        (rule) =>
          rule.orgId === where.orgId &&
          (!ptypes || ptypes.includes(rule.ptype)),
      );
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rules.find(
        (rule) =>
          rule.orgId === where.orgId &&
          rule.ptype === where.ptype &&
          rule.v0 === where.v0 &&
          rule.v1 === where.v1 &&
          rule.v2 === where.v2,
      ) ?? null,
    create: async ({ data }: { data: Omit<Rule, "id"> }) => {
      const created = { id: nextId++, ...data };
      rules.push(created);
      return created;
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = rules.length;
      for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index]!;
        if (
          rule.orgId === where.orgId &&
          rule.ptype === where.ptype &&
          rule.v0 === where.v0 &&
          rule.v1 === where.v1 &&
          rule.v2 === where.v2
        ) {
          rules.splice(index, 1);
        }
      }
      return { count: before - rules.length };
    },
  };
  const transaction = { casbinRule };
  const prisma = {
    casbinRule,
    collection: {
      findUnique: async () => ({
        id: "collection_tasks",
        orgId: "org_123",
        name: "tasks",
        schema: { title: "string" },
      }),
    },
    rowFilter: {
      findMany: async () => [],
    },
    member: {
      findMany: async ({ where }: { where: { organizationId: string } }) =>
        members.filter(
          (member) => member.organizationId === where.organizationId,
        ),
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const key = where.organizationId_userId as {
          organizationId: string;
          userId: string;
        };
        return (
          members.find(
            (member) =>
              member.organizationId === key.organizationId &&
              member.userId === key.userId,
          ) ?? null
        );
      },
    },
    user: {
      findUnique: async ({ where }: { where: { email: string } }) =>
        users.find((user) => user.email === where.email) ?? null,
    },
    $transaction: async <T>(
      operation: (client: typeof transaction) => Promise<T>,
    ) => operation(transaction),
  };

  return { prisma, rules };
}

function createPermissionApp(prisma: unknown) {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (context, next) => {
    context.set("orgId", "org_123");
    context.set("userId", "user_admin");
    context.set("services", { prisma } as never);
    await next();
  });
  app.route("/v1/orgs/:orgId/permissions", permissionRouter);
  return app;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("permission routes", () => {
  test("creates, lists, checks, and deletes policies and role assignments", async () => {
    const { prisma } = createPrismaFixture();
    const app = createPermissionApp(prisma);
    const base = "/v1/orgs/org_123/permissions";

    const policy = {
      subject: "role:reader",
      resource: "/collections/*",
      action: "read",
    };
    const addPolicyResponse = await app.request(
      `${base}/policies`,
      jsonRequest("POST", policy),
    );
    expect(addPolicyResponse.status).toBe(201);

    const addRoleResponse = await app.request(
      `${base}/roles`,
      jsonRequest("POST", { user_id: "reader@example.com", role: "reader" }),
    );
    expect(addRoleResponse.status).toBe(201);

    const allowedResponse = await app.request(
      `${base}/check`,
      jsonRequest("POST", {
        user_id: "user_reader",
        resource: "/collections/tasks",
        action: "read",
      }),
    );
    expect(allowedResponse.status).toBe(200);
    expect(await allowedResponse.json()).toMatchObject({
      status: "ok",
      allowed: true,
    });

    const deniedResponse = await app.request(
      `${base}/check`,
      jsonRequest("POST", {
        user_id: "user_reader",
        resource: "/collections/tasks",
        action: "write",
      }),
    );
    expect(await deniedResponse.json()).toMatchObject({ allowed: false });

    const listResponse = await app.request(base);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      status: "ok",
      policies: expect.arrayContaining([policy]),
      role_assignments: expect.arrayContaining([
        { user_id: "user_reader", role: "reader" },
      ]),
    });

    expect(
      (
        await app.request(
          `${base}/roles`,
          jsonRequest("DELETE", { user_id: "user_reader", role: "reader" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await app.request(`${base}/policies`, jsonRequest("DELETE", policy)))
        .status,
    ).toBe(200);
  });

  test("supports direct user policies and rejects policies for non-members", async () => {
    const { prisma } = createPrismaFixture();
    const app = createPermissionApp(prisma);
    const base = "/v1/orgs/org_123/permissions/policies";

    const response = await app.request(
      base,
      jsonRequest("POST", {
        subject: "user:reader@example.com",
        resource: "/collections/tasks",
        action: "write",
      }),
    );
    expect(response.status).toBe(201);

    const directCheck = await app.request(
      "/v1/orgs/org_123/permissions/check",
      jsonRequest("POST", {
        user_id: "user_reader",
        resource: "/collections/tasks",
        action: "write",
      }),
    );
    expect(await directCheck.json()).toMatchObject({ allowed: true });

    const otherActionCheck = await app.request(
      "/v1/orgs/org_123/permissions/check",
      jsonRequest("POST", {
        user_id: "user_reader",
        resource: "/collections/tasks",
        action: "delete",
      }),
    );
    expect(await otherActionCheck.json()).toMatchObject({ allowed: false });

    const rejected = await app.request(
      base,
      jsonRequest("POST", {
        subject: "user:outside_user",
        resource: "/collections/tasks",
        action: "read",
      }),
    );
    expect(rejected.status).toBe(403);
  });
});

describe("collection permission middleware", () => {
  test("honors role and resource wildcards while denying other actions", async () => {
    const { prisma, rules } = createPrismaFixture();
    rules.push(
      {
        id: 4,
        orgId: "org_123",
        ptype: "p",
        v0: "org:org_123:user:reader",
        v1: "/collections/*",
        v2: "read",
      },
      {
        id: 5,
        orgId: "org_123",
        ptype: "g",
        v0: "user_reader",
        v1: "org:org_123:user:reader",
        v2: null,
      },
    );
    const app = new Hono<AppEnvironment>();
    app.use("*", async (context, next) => {
      context.set("orgId", "org_123");
      context.set("userId", "user_reader");
      context.set("services", { prisma } as never);
      await next();
    });
    app.get(
      "/collections/:name",
      requireCollectionPermission("read"),
      (context) => context.json({ status: "ok" }),
    );
    app.post(
      "/collections/:name",
      requireCollectionPermission("write"),
      (context) => context.json({ status: "ok" }),
    );

    expect((await app.request("/collections/tasks")).status).toBe(200);
    const denied = await app.request("/collections/tasks", { method: "POST" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      status: "error",
      error: "PermissionDenied",
    });
  });
});

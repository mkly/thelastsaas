import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import type { AppEnvironment } from "../src/env";
import { createAuthMiddleware } from "../src/middleware/auth";

const user = {
  id: "user_123",
  name: "Session User",
  email: "session-user@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createProtectedApp(auth: unknown, prisma: unknown) {
  const app = new Hono<AppEnvironment>();
  app.use("/v1/orgs/:orgId/*", createAuthMiddleware({ auth, prisma } as never));
  app.get("/v1/orgs/:orgId/probe", (context) =>
    context.json({
      orgId: context.get("orgId"),
      userId: context.get("userId"),
    }),
  );
  app.post("/v1/orgs/:orgId/mutation", async (context) => {
    await context.get("audit")("update_probe", "probe", "probe_123", {
      changed: true,
    });
    return context.json({ status: "ok" });
  });
  return app;
}

describe("organization session middleware", () => {
  test("returns 401 when BetterAuth cannot resolve the supplied credential", async () => {
    const getSession = mock().mockResolvedValue(null);
    const member = {
      findFirst: mock(),
      findUnique: mock(),
    };
    const app = createProtectedApp({ api: { getSession } }, { member });

    const response = await app.request("/v1/orgs/org_123/probe", {
      headers: { Authorization: "Bearer lsk_removed-api-key" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      status: "error",
      error: "Unauthorized",
      message: "Missing or invalid authentication",
    });
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(member.findFirst).not.toHaveBeenCalled();
    expect(member.findUnique).not.toHaveBeenCalled();
  });

  test("returns 403 when the session user is not a member of the path org", async () => {
    const member = {
      findFirst: mock().mockResolvedValue({ organizationId: "org_other" }),
      findUnique: mock().mockResolvedValue(null),
    };
    const app = createProtectedApp(
      {
        api: {
          getSession: mock().mockResolvedValue({
            session: { id: "session_123", activeOrganizationId: "org_other" },
            user,
          }),
        },
      },
      { member },
    );

    const response = await app.request("/v1/orgs/org_requested/probe");

    expect(response.status).toBe(403);
    expect(member.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_userId: {
          organizationId: "org_requested",
          userId: "user_123",
        },
      },
      select: { id: true },
    });
  });

  test("creates a personal org and its default policies on first access", async () => {
    const createOrganization = mock().mockResolvedValue({ id: "org_personal" });
    const policyFind = mock().mockResolvedValue(null);
    const policyCreate = mock().mockResolvedValue({});
    const auditCreate = mock().mockResolvedValue({});
    const prisma = {
      member: {
        findFirst: mock().mockResolvedValue(null),
        findUnique: mock().mockResolvedValue({ id: "member_123" }),
      },
      $transaction: mock().mockImplementation(
        async (operation: (transaction: unknown) => Promise<void>) =>
          operation({
            casbinRule: { findFirst: policyFind, create: policyCreate },
          }),
      ),
      auditLog: { create: auditCreate },
    };
    const app = createProtectedApp(
      {
        api: {
          getSession: mock().mockResolvedValue({
            session: { id: "session_123" },
            user,
          }),
          createOrganization,
        },
      },
      prisma,
    );

    const response = await app.request("/v1/orgs/org_personal/probe");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      orgId: "org_personal",
      userId: "user_123",
    });
    expect(createOrganization).toHaveBeenCalledWith({
      body: {
        name: "Session User's Org",
        slug: "personal-user_123",
        userId: "user_123",
        keepCurrentActiveOrganization: true,
      },
    });
    expect(policyCreate).toHaveBeenCalledTimes(2);
    expect(policyCreate).toHaveBeenCalledWith({
      data: {
        orgId: "org_personal",
        ptype: "p",
        v0: "org:org_personal:user:admin",
        v1: "/*",
        v2: "*",
      },
    });
    expect(policyCreate).toHaveBeenCalledWith({
      data: {
        orgId: "org_personal",
        ptype: "g",
        v0: "user_123",
        v1: "org:org_personal:user:admin",
        v2: null,
      },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        orgId: "org_personal",
        userId: "user_123",
        action: "create_organization",
        resourceType: "organization",
        resourceId: "org_personal",
        details: { personal: true },
      },
    });
  });

  test("provides routes an audit writer bound to the real session user", async () => {
    const auditCreate = mock().mockResolvedValue({});
    const prisma = {
      member: {
        findFirst: mock().mockResolvedValue({ organizationId: "org_123" }),
        findUnique: mock().mockResolvedValue({ id: "member_123" }),
      },
      auditLog: { create: auditCreate },
    };
    const app = createProtectedApp(
      {
        api: {
          getSession: mock().mockResolvedValue({
            session: { id: "session_123" },
            user,
          }),
        },
      },
      prisma,
    );

    const response = await app.request("/v1/orgs/org_123/mutation", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        orgId: "org_123",
        userId: "user_123",
        action: "update_probe",
        resourceType: "probe",
        resourceId: "probe_123",
        details: { changed: true },
      },
    });
  });
});

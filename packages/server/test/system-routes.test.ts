import { describe, expect, mock, test } from "bun:test";

import { createApp } from "../src/app";

const user = {
  id: "user_123",
  name: "Session User",
  email: "session-user@example.com",
};

function createSystemApp(prisma: Record<string, unknown>) {
  const member = {
    findFirst: mock().mockResolvedValue({ organizationId: "org_123" }),
    findUnique: mock().mockResolvedValue({ id: "member_123" }),
  };
  const auth = {
    api: {
      getSession: mock().mockResolvedValue({
        session: { id: "session_123" },
        user,
      }),
    },
    handler: mock(),
  };

  return createApp({
    config: {} as never,
    services: { auth, prisma: { member, ...prisma } } as never,
  });
}

describe("organization system routes", () => {
  test("returns collection, record, file, and storage counts for the path org", async () => {
    const collectionCount = mock().mockResolvedValue(3);
    const recordCount = mock().mockResolvedValue(17);
    const fileCount = mock().mockResolvedValue(4);
    const fileAggregate = mock().mockResolvedValue({
      _sum: { sizeBytes: 8192 },
    });
    const app = createSystemApp({
      collection: { count: collectionCount },
      record: { count: recordCount },
      file: { count: fileCount, aggregate: fileAggregate },
    });

    const response = await app.request("/v1/orgs/org_123/stats");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      collections: 3,
      records: 17,
      files: 4,
      storage_bytes: 8192,
    });
    expect(collectionCount).toHaveBeenCalledWith({
      where: { orgId: "org_123" },
    });
    expect(recordCount).toHaveBeenCalledWith({
      where: { orgId: "org_123" },
    });
    expect(fileCount).toHaveBeenCalledWith({
      where: { orgId: "org_123" },
    });
    expect(fileAggregate).toHaveBeenCalledWith({
      where: { orgId: "org_123" },
      _sum: { sizeBytes: true },
    });
  });

  test("returns newest audit entries filtered within the path org", async () => {
    const createdAt = new Date("2026-08-19T02:00:00.000Z");
    const findMany = mock().mockResolvedValue([
      {
        id: "audit_123",
        orgId: "org_123",
        userId: "user_123",
        action: "update_probe",
        resourceType: "probe",
        resourceId: "probe_123",
        details: { changed: true },
        createdAt,
      },
    ]);
    const app = createSystemApp({ auditLog: { findMany } });

    const response = await app.request(
      "/v1/orgs/org_123/audit-log?limit=5&action=update_probe&resource_type=probe",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      entries: [
        {
          id: "audit_123",
          user_id: "user_123",
          action: "update_probe",
          resource_type: "probe",
          resource_id: "probe_123",
          details: { changed: true },
          created_at: "2026-08-19T02:00:00.000Z",
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org_123",
        action: "update_probe",
        resourceType: "probe",
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
  });
});

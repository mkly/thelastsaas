import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { closeServices, createServices } from "../src/services";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260819015000_init/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

const RECURRENCE_VALUE =
  "DTSTART;TZID=America/New_York:20260901T090000\nRRULE:FREQ=WEEKLY;COUNT=4";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createWalkthroughStack() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-e2e-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
  });
  const services = await createServices(config);
  if (!services.database) throw new Error("Expected SQLite database handle");
  services.database.exec(migration);
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  return { app: createApp({ config, services }), services };
}

type Stack = Awaited<ReturnType<typeof createWalkthroughStack>>;

interface Session {
  browserCookie: string;
  token: string;
  userId: string;
  orgId: string;
}

function jsonRequest(token: string, body?: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function json<T = Record<string, unknown>>(
  response: Response,
  expectedStatus: number,
): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== expectedStatus) {
    throw new Error(
      `Expected status ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function signUp(
  { app, services }: Stack,
  email: string,
  name: string,
): Promise<Session> {
  const signUpResponse = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "walkthrough-password", name }),
  });
  expect(signUpResponse.status).toBe(200);
  const token = signUpResponse.headers.get("set-auth-token");
  if (!token) throw new Error("Sign-up did not return a bearer token");
  const browserCookie = signUpResponse.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
  if (!browserCookie)
    throw new Error("Sign-up did not return a browser cookie");

  const created = await json<{ organization: { id: string } }>(
    await app.request(
      "/v1/orgs",
      jsonRequest(token, {
        name: `${name}'s Org`,
        slug: `${name.toLowerCase().replaceAll(" ", "-")}-org`,
      }),
    ),
    201,
  );

  const user = await services.prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`User ${email} missing after sign-up`);
  return {
    browserCookie,
    token,
    userId: user.id,
    orgId: created.organization.id,
  };
}

async function issueDeviceToken(
  app: Stack["app"],
  browserCookie: string,
): Promise<string> {
  const device = await json<{
    device_code: string;
    user_code: string;
  }>(
    await app.request(
      "/api/auth/device/code",
      jsonRequest("", { client_id: "lastsaas-cli" }),
    ),
    200,
  );
  const approvalPage = await app.request(
    `/auth/device?user_code=${encodeURIComponent(device.user_code)}`,
    { headers: { cookie: browserCookie } },
  );
  expect(approvalPage.status).toBe(200);
  expect(await approvalPage.text()).toContain(device.user_code);
  const approval = await app.request("/auth/device/approve", {
    method: "POST",
    headers: {
      cookie: browserCookie,
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://localhost",
    },
    body: new URLSearchParams({ user_code: device.user_code }).toString(),
  });
  expect(approval.status).toBe(200);
  expect(await approval.text()).toContain("Device Authorized");
  const token = await json<{ access_token: string; token_type: string }>(
    await app.request(
      "/api/auth/device/token",
      jsonRequest("", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: "lastsaas-cli",
      }),
    ),
    200,
  );
  expect(token.token_type).toBe("Bearer");
  expect(token.access_token.startsWith("lst_")).toBe(false);
  return token.access_token;
}

async function auditActions(
  app: Stack["app"],
  session: Session,
): Promise<Map<string, number>> {
  const response = await app.request(
    `/v1/orgs/${session.orgId}/audit-log?limit=100`,
    { headers: { authorization: `Bearer ${session.token}` } },
  );
  const body = await json<{ entries: Array<{ action: string }> }>(
    response,
    200,
  );
  const counts = new Map<string, number>();
  for (const entry of body.entries) {
    counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  }
  return counts;
}

describe("end-to-end walkthrough", () => {
  test("sign-up through export/import round-trip over the real HTTP app", async () => {
    const stack = await createWalkthroughStack();
    const { app, services } = stack;

    const admin = await signUp(stack, "admin@example.com", "Ada Admin");
    const submitter = await signUp(stack, "sam@example.com", "Sam Submitter");
    const orgId = admin.orgId;
    expect(orgId).not.toBe(submitter.orgId);
    expect(
      (
        await app.request("/auth/dashboard", {
          headers: { cookie: admin.browserCookie },
        })
      ).status,
    ).toBe(200);
    admin.token = await issueDeviceToken(app, admin.browserCookie);
    submitter.token = await issueDeviceToken(app, submitter.browserCookie);

    const collectionResponse = await app.request(
      `/v1/orgs/${orgId}/collections`,
      jsonRequest(admin.token, {
        name: "events",
        schema: {
          title: "string",
          notes: "string",
          schedule: "recurrence",
        },
        description: "Team events",
      }),
    );
    await json(collectionResponse, 200);

    const invitation = await json<{ invitation_id: string }>(
      await app.request(
        `/v1/orgs/${orgId}/invitations`,
        jsonRequest(admin.token, {
          email: "sam@example.com",
          role: "member",
        }),
      ),
      201,
    );
    await json(
      await app.request(
        `/v1/orgs/${orgId}/invitations/accept`,
        jsonRequest(submitter.token, {
          invitation_id: invitation.invitation_id,
        }),
      ),
      200,
    );

    const canceledInvitation = await json<{ invitation_id: string }>(
      await app.request(
        `/v1/orgs/${orgId}/invitations`,
        jsonRequest(admin.token, {
          email: "cancel-me@example.com",
          role: "member",
        }),
      ),
      201,
    );
    await json(
      await app.request(
        `/v1/orgs/${orgId}/invitations/cancel`,
        jsonRequest(admin.token, {
          invitation_id: canceledInvitation.invitation_id,
        }),
      ),
      200,
    );

    const members = await json<{
      members: Array<{ member_id: string; user_id: string }>;
    }>(
      await app.request(`/v1/orgs/${orgId}/members`, {
        headers: { authorization: `Bearer ${admin.token}` },
      }),
      200,
    );
    const submitterMember = members.members.find(
      (member) => member.user_id === submitter.userId,
    );
    if (!submitterMember) throw new Error("Accepted member is missing");
    for (const role of ["admin", "member"] as const) {
      await json(
        await app.request(
          `/v1/orgs/${orgId}/members/${submitterMember.member_id}/role`,
          { ...jsonRequest(admin.token, { role }), method: "PATCH" },
        ),
        200,
      );
    }

    // Accepting as "member" auto-grants role:member read on /*; drop it so
    // the submitter's access flows only through the filtered custom role.
    await json(
      await app.request(`/v1/orgs/${orgId}/permissions/policies`, {
        ...jsonRequest(admin.token, {
          subject: "role:member",
          resource: "/*",
          action: "read",
        }),
        method: "DELETE",
      }),
      200,
    );
    for (const action of ["read", "write"] as const) {
      await json(
        await app.request(
          `/v1/orgs/${orgId}/permissions/policies`,
          jsonRequest(admin.token, {
            subject: "role:submitter",
            resource: "/collections/events",
            action,
          }),
        ),
        201,
      );
    }
    await json(
      await app.request(
        `/v1/orgs/${orgId}/permissions/roles`,
        jsonRequest(admin.token, {
          user_id: submitter.userId,
          role: "submitter",
        }),
      ),
      201,
    );
    await json(
      await app.request(
        `/v1/orgs/${orgId}/permissions/row-filters`,
        jsonRequest(admin.token, {
          collection: "events",
          role: "submitter",
          action: "read",
          condition: { created_by: "$user.id" },
        }),
      ),
      200,
    );
    await json(
      await app.request(
        `/v1/orgs/${orgId}/permissions/field-filters`,
        jsonRequest(admin.token, {
          collection: "events",
          role: "submitter",
          action: "write",
          readable_fields: ["title", "notes", "schedule"],
          writable_fields: ["title", "schedule"],
        }),
      ),
      200,
    );

    const denied = await app.request(
      `/v1/orgs/${orgId}/collections/events/records`,
      jsonRequest(submitter.token, {
        data: { title: "Sneaky", notes: "not writable" },
      }),
    );
    expect(denied.status).toBe(403);

    await json(
      await app.request(
        `/v1/orgs/${orgId}/collections/events/records`,
        jsonRequest(submitter.token, {
          data: { title: "Standup", schedule: RECURRENCE_VALUE },
        }),
      ),
      200,
    );
    await json(
      await app.request(
        `/v1/orgs/${orgId}/collections/events/records`,
        jsonRequest(admin.token, {
          data: { title: "Board meeting", notes: "admins only" },
        }),
      ),
      200,
    );

    const submitterView = await json<{
      total: number;
      records: Array<{ created_by: string }>;
    }>(
      await app.request(
        `/v1/orgs/${orgId}/collections/events/records/query`,
        jsonRequest(submitter.token, {}),
      ),
      200,
    );
    expect(submitterView.total).toBe(1);
    expect(submitterView.records[0]?.created_by).toBe(submitter.userId);

    const adminView = await json<{ total: number }>(
      await app.request(
        `/v1/orgs/${orgId}/collections/events/records/query`,
        jsonRequest(admin.token, {}),
      ),
      200,
    );
    expect(adminView.total).toBe(2);

    const occurrences = await json<{
      records: Array<{ occurrences?: string[] }>;
    }>(
      await app.request(
        `/v1/orgs/${orgId}/collections/events/records/query`,
        jsonRequest(admin.token, {
          where: {
            schedule: {
              occurs_between: [
                "2026-09-01T00:00:00.000Z",
                "2026-09-30T00:00:00.000Z",
              ],
            },
          },
        }),
      ),
      200,
    );
    expect(occurrences.records).toHaveLength(1);
    expect(occurrences.records[0]?.occurrences).toHaveLength(4);

    const oversized = await json<{ error: string }>(
      await app.request(
        `/v1/orgs/${orgId}/collections/events/records/query`,
        jsonRequest(admin.token, {
          where: {
            schedule: {
              occurs_between: [
                "2026-01-01T00:00:00.000Z",
                "2030-01-01T00:00:00.000Z",
              ],
            },
          },
        }),
      ),
      400,
    );
    expect(oversized.error).toBe("RECURRENCE_WINDOW_LIMIT");

    await json(
      await app.request(
        `/v1/orgs/${orgId}/notifications/schedules`,
        jsonRequest(admin.token, {
          message: "Walkthrough digest",
          deliver_at: "2026-01-01T09:00:00.000Z",
        }),
      ),
      201,
    );
    await services.scheduler.start();
    const notifications = await json<{
      notifications: Array<{ message: string }>;
    }>(
      await app.request(`/v1/orgs/${orgId}/notifications`, {
        headers: { authorization: `Bearer ${admin.token}` },
      }),
      200,
    );
    expect(
      notifications.notifications.some(
        (notification) => notification.message === "Walkthrough digest",
      ),
    ).toBe(true);

    const exportBody = await json<Record<string, unknown>>(
      await app.request(`/v1/orgs/${orgId}/export`, jsonRequest(admin.token)),
      200,
    );
    expect(exportBody.version).toBe(1);

    const importer = await signUp(stack, "iris@example.com", "Iris Import");
    const imported = await json<Record<string, unknown>>(
      await app.request(
        `/v1/orgs/${importer.orgId}/import`,
        jsonRequest(importer.token, exportBody),
      ),
      200,
    );
    expect(imported).toMatchObject({
      imported_collections: 1,
      imported_records: 2,
      imported_row_filters: 1,
      imported_field_filters: 1,
      imported_notification_schedules: 1,
    });
    const roundTrip = await json<{ records: unknown[] }>(
      await app.request(
        `/v1/orgs/${importer.orgId}/collections/events/records/query`,
        jsonRequest(importer.token, {}),
      ),
      200,
    );
    expect(roundTrip.records).toHaveLength(2);

    const sourceAudit = await auditActions(app, admin);
    for (const action of [
      "create_organization",
      "create_collection",
      "create_invitation",
      "accept_invitation",
      "cancel_invitation",
      "update_member_role",
      "add_policy",
      "remove_policy",
      "assign_role",
      "set_row_filter",
      "set_field_filter",
      "insert_record",
      "create_notification_schedule",
      "export_data",
    ]) {
      expect(sourceAudit.get(action) ?? 0).toBeGreaterThanOrEqual(1);
    }
    const importerAudit = await auditActions(app, importer);
    expect(importerAudit.get("import_data") ?? 0).toBe(1);
  }, 30000);
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApiClient, handleResponse } from "../api-client";
import { createProgram } from "../index";
import type { AccessCommandDependencies } from "./access-client";
import { registerMembers } from "./members";
import { registerPermissions } from "./permissions";

interface CapturedOutput {
  value: unknown;
  options: { json?: boolean };
  human?: string;
}

const originalFetch = globalThis.fetch;
const requests: Request[] = [];
const responseBodies: unknown[] = [];
const outputs: CapturedOutput[] = [];
let requestedOrg: string | undefined;

const dependencies: AccessCommandDependencies = {
  getOrgClient(options) {
    requestedOrg = options?.org;
    const config = {
      server: "https://api.example.test",
      session_token: "session-token",
    };
    return {
      client: createApiClient(config.server, config.session_token),
      config,
      orgId: options?.org ?? "org_default",
    };
  },
  handleResponse,
  writeOutput(value, options = {}, human) {
    outputs.push({ value, options, human });
  },
};

beforeEach(() => {
  requests.length = 0;
  responseBodies.length = 0;
  outputs.length = 0;
  requestedOrg = undefined;
  globalThis.fetch = (async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(responseBodies.shift() ?? { status: "ok" });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function permissionProgram() {
  return createProgram([(root) => registerPermissions(root, dependencies)]);
}

function memberProgram() {
  return createProgram([(root) => registerMembers(root, dependencies)]);
}

async function runPermission(
  args: string[],
  response: unknown = { status: "ok" },
): Promise<void> {
  responseBodies.push(response);
  await permissionProgram().parseAsync(["bun", "saas", ...args]);
}

async function runMember(
  args: string[],
  response: unknown = { status: "ok" },
): Promise<void> {
  responseBodies.push(response);
  await memberProgram().parseAsync(["bun", "saas", ...args]);
}

async function requestBody(index: number): Promise<unknown> {
  return requests[index]?.json();
}

describe("access-control command registration", () => {
  test("registers permission and member families with their full surface", () => {
    const program = createProgram();
    const permissions = program.commands.find(
      (command) => command.name() === "permissions",
    );
    const members = program.commands.find(
      (command) => command.name() === "members",
    );

    expect(permissions?.alias()).toBe("p");
    expect(permissions?.commands.map((command) => command.name())).toEqual([
      "list",
      "grant",
      "revoke",
      "assign",
      "unassign",
      "check",
      "invite",
      "invitations",
      "accept-invite",
      "cancel-invite",
      "row-filter",
      "field-filter",
    ]);
    expect(
      permissions?.commands
        .find((command) => command.name() === "row-filter")
        ?.commands.map((command) => command.name()),
    ).toEqual(["set", "list", "delete"]);
    expect(
      permissions?.commands
        .find((command) => command.name() === "field-filter")
        ?.commands.map((command) => command.name()),
    ).toEqual(["set", "list", "delete"]);
    expect(members?.alias()).toBe("m");
    expect(members?.commands.map((command) => command.name())).toEqual([
      "list",
      "role-change",
      "remove",
    ]);
  });
});

describe("permission policy and role commands", () => {
  test("lists policies and targets the selected organization", async () => {
    await runPermission(["--org", "org_alpha", "permissions", "list"], {
      status: "ok",
      policies: [
        {
          subject: "role:editor",
          resource: "/collections/*",
          action: "read",
        },
      ],
      role_assignments: [{ user_id: "user_1", role: "editor" }],
    });

    expect(requestedOrg).toBe("org_alpha");
    expect(requests[0]?.method).toBe("GET");
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/v1/orgs/org_alpha/permissions",
    );
    expect(outputs[0]?.human).toContain("role:editor");
    expect(outputs[0]?.human).toContain("user_1");
  });

  test("grants, revokes, assigns, unassigns, and checks access", async () => {
    await runPermission([
      "permissions",
      "grant",
      "--subject",
      "role:editor",
      "--resource",
      "/collections/*",
      "--action",
      "write",
    ]);
    await runPermission([
      "permissions",
      "revoke",
      "--subject",
      "role:editor",
      "--resource",
      "/collections/*",
      "--action",
      "write",
    ]);
    await runPermission([
      "permissions",
      "assign",
      "--user",
      "person@example.test",
      "--role",
      "editor",
    ]);
    await runPermission([
      "permissions",
      "unassign",
      "--user",
      "person@example.test",
      "--role",
      "editor",
    ]);
    await runPermission(
      [
        "permissions",
        "check",
        "--user",
        "person@example.test",
        "--resource",
        "/collections/contacts",
        "--action",
        "read",
      ],
      { status: "ok", allowed: false },
    );

    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "DELETE",
      "POST",
      "DELETE",
      "POST",
    ]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/orgs/org_default/permissions/policies",
      "/v1/orgs/org_default/permissions/policies",
      "/v1/orgs/org_default/permissions/roles",
      "/v1/orgs/org_default/permissions/roles",
      "/v1/orgs/org_default/permissions/check",
    ]);
    expect(await requestBody(0)).toEqual({
      subject: "role:editor",
      resource: "/collections/*",
      action: "write",
    });
    expect(await requestBody(2)).toEqual({
      user_id: "person@example.test",
      role: "editor",
    });
    expect(await requestBody(4)).toEqual({
      user_id: "person@example.test",
      resource: "/collections/contacts",
      action: "read",
    });
    expect(outputs.at(-1)?.human).toBe("DENIED");
  });
});

describe("invitation commands", () => {
  test("creates, lists, accepts, and cancels invitations", async () => {
    await runPermission(
      [
        "permissions",
        "invite",
        "--email",
        "new@example.test",
        "--role",
        "admin",
      ],
      { status: "ok", invitation_id: "invite_1" },
    );
    await runPermission(["permissions", "invitations"], {
      status: "ok",
      invitations: [],
    });
    await runPermission(["permissions", "accept-invite", "--id", "invite_1"]);
    await runPermission(["permissions", "cancel-invite", "--id", "invite_2"]);

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/orgs/org_default/invitations",
      "/v1/orgs/org_default/invitations",
      "/v1/orgs/org_default/invitations/accept",
      "/v1/orgs/org_default/invitations/cancel",
    ]);
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "POST",
      "POST",
    ]);
    expect(await requestBody(0)).toEqual({
      email: "new@example.test",
      role: "admin",
    });
    expect(await requestBody(2)).toEqual({ invitation_id: "invite_1" });
    expect(await requestBody(3)).toEqual({ invitation_id: "invite_2" });
  });
});

describe("row and field filter commands", () => {
  test("sets, lists, and deletes row filters", async () => {
    await runPermission(
      [
        "permissions",
        "row-filter",
        "set",
        "--collection",
        "tickets",
        "--role",
        "agent",
        "--action",
        "read",
        "--condition",
        '{"created_by":{"eq":"$user.id"}}',
      ],
      { status: "ok", id: "row_filter_1" },
    );
    await runPermission(
      ["permissions", "row-filter", "list", "--collection", "tickets"],
      { status: "ok", row_filters: [] },
    );
    await runPermission([
      "permissions",
      "row-filter",
      "delete",
      "row_filter_1",
    ]);

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/orgs/org_default/permissions/row-filters",
      "/v1/orgs/org_default/permissions/row-filters",
      "/v1/orgs/org_default/permissions/row-filters/row_filter_1",
    ]);
    expect(new URL(requests[1]!.url).searchParams.get("collection")).toBe(
      "tickets",
    );
    expect(await requestBody(0)).toEqual({
      collection: "tickets",
      role: "agent",
      action: "read",
      condition: { created_by: { eq: "$user.id" } },
    });
  });

  test("sets, lists, and deletes field filters", async () => {
    await runPermission(
      [
        "permissions",
        "field-filter",
        "set",
        "--collection",
        "tickets",
        "--role",
        "agent",
        "--action",
        "write",
        "--readable-fields",
        '["title","status"]',
        "--writable-fields",
        '["status"]',
      ],
      { status: "ok", id: "field_filter_1" },
    );
    await runPermission(
      ["permissions", "field-filter", "list", "--collection", "tickets"],
      { status: "ok", field_filters: [] },
    );
    await runPermission([
      "permissions",
      "field-filter",
      "delete",
      "field_filter_1",
    ]);

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/orgs/org_default/permissions/field-filters",
      "/v1/orgs/org_default/permissions/field-filters",
      "/v1/orgs/org_default/permissions/field-filters/field_filter_1",
    ]);
    expect(await requestBody(0)).toEqual({
      collection: "tickets",
      role: "agent",
      action: "write",
      readable_fields: ["title", "status"],
      writable_fields: ["status"],
    });
  });
});

describe("member commands", () => {
  test("lists, changes the role of, and removes members", async () => {
    await runMember(
      [
        "--org",
        "org_alpha",
        "members",
        "list",
        "--role",
        "member",
        "--search",
        "casey",
        "--limit",
        "20",
        "--offset",
        "5",
      ],
      { status: "ok", members: [], total: 0, limit: 20, offset: 5 },
    );
    await runMember(["members", "role-change", "member_1", "--role", "admin"]);
    await runMember(["members", "remove", "member_1"]);

    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "PATCH",
      "DELETE",
    ]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/orgs/org_alpha/members",
      "/v1/orgs/org_default/members/member_1/role",
      "/v1/orgs/org_default/members/member_1",
    ]);
    const query = new URL(requests[0]!.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      limit: "20",
      offset: "5",
      role: "member",
      q: "casey",
    });
    expect(await requestBody(1)).toEqual({ role: "admin" });
  });
});

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { syncMemberRole } from "../src/db/casbin";
import type { AppEnvironment } from "../src/env";
import { invitationRouter } from "../src/routes/invitations";
import { memberRouter } from "../src/routes/members";

interface UserRow {
  id: string;
  email: string;
  name: string;
}

interface MemberRow {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
}

interface InvitationRow {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}

interface RuleRow {
  id: number;
  orgId: string;
  ptype: string;
  v0: string | null;
  v1: string | null;
  v2: string | null;
}

function createFixture() {
  let nextRuleId = 3;
  let nextInvitationId = 1;
  const users: UserRow[] = [
    { id: "user_admin", email: "admin@example.com", name: "Admin" },
    { id: "user_agent", email: "agent@example.com", name: "Agent User" },
  ];
  const members: MemberRow[] = [
    {
      id: "member_admin",
      organizationId: "org_123",
      userId: "user_admin",
      role: "admin",
      createdAt: new Date("2026-08-18T00:00:00Z"),
    },
  ];
  const invitations: InvitationRow[] = [];
  const rules: RuleRow[] = [
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

  const matchesRule = (rule: RuleRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === "ptype" && typeof value === "object" && value) {
        return (value as { in: string[] }).in.includes(rule.ptype);
      }
      return rule[key as keyof RuleRow] === value;
    });

  const casbinRule = {
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      rules.filter((rule) => matchesRule(rule, where)),
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rules.find((rule) => matchesRule(rule, where)) ?? null,
    create: async ({ data }: { data: Omit<RuleRow, "id"> }) => {
      const rule = { id: nextRuleId++, ...data };
      rules.push(rule);
      return rule;
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = rules.length;
      for (let index = rules.length - 1; index >= 0; index -= 1) {
        if (matchesRule(rules[index]!, where)) rules.splice(index, 1);
      }
      return { count: before - rules.length };
    },
  };

  function filteredMembers(where: Record<string, unknown>) {
    const search = (
      where.user as { OR?: Array<Record<string, unknown>> } | undefined
    )?.OR?.flatMap((clause) => Object.values(clause)).map(
      (filter) => (filter as { contains: string }).contains,
    )[0];
    return members.filter((member) => {
      if (member.organizationId !== where.organizationId) return false;
      if (where.id && member.id !== where.id) return false;
      if (where.role && member.role !== where.role) return false;
      if (!search) return true;
      const user = users.find(({ id }) => id === member.userId)!;
      return `${user.email} ${user.name}`.includes(search);
    });
  }

  const prisma = {
    casbinRule,
    member: {
      findMany: async ({
        where,
        take = 50,
        skip = 0,
      }: {
        where: Record<string, unknown>;
        take?: number;
        skip?: number;
      }) =>
        filteredMembers(where)
          .slice(skip, skip + take)
          .map((member) => ({
            ...member,
            user: users.find(({ id }) => id === member.userId)!,
          })),
      count: async ({ where }: { where: Record<string, unknown> }) =>
        filteredMembers(where).length,
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        filteredMembers(where)[0] ?? null,
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const key = where.organizationId_userId as
          { organizationId: string; userId: string } | undefined;
        if (!key) return null;
        return (
          members.find(
            (member) =>
              member.organizationId === key.organizationId &&
              member.userId === key.userId,
          ) ?? null
        );
      },
    },
    invitation: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        invitations.filter(
          (invitation) =>
            invitation.organizationId === where.organizationId &&
            invitation.status === where.status,
        ),
      findUnique: async ({ where }: { where: { id: string } }) =>
        invitations.find(({ id }) => id === where.id) ?? null,
    },
    $transaction: async <T>(
      operation: (transaction: { casbinRule: typeof casbinRule }) => Promise<T>,
    ) => operation({ casbinRule }),
  };

  const auth = {
    api: {
      createInvitation: async ({
        body,
      }: {
        body: { email: string; role: string; organizationId: string };
      }) => {
        const invitation = {
          id: `invitation_${nextInvitationId++}`,
          organizationId: body.organizationId,
          email: body.email,
          role: body.role,
          status: "pending",
          expiresAt: new Date("2026-08-20T00:00:00Z"),
          createdAt: new Date("2026-08-18T01:00:00Z"),
        };
        invitations.push(invitation);
        return invitation;
      },
      acceptInvitation: async ({
        body,
        headers,
      }: {
        body: { invitationId: string };
        headers: Headers;
      }) => {
        const invitation = invitations.find(
          ({ id }) => id === body.invitationId,
        );
        const userId = headers.get("x-user-id")!;
        const user = users.find(({ id }) => id === userId)!;
        if (!invitation || invitation.email !== user.email) {
          throw new Error("Invitation does not belong to this user");
        }
        invitation.status = "accepted";
        const member = {
          id: `member_${userId.slice("user_".length)}`,
          organizationId: invitation.organizationId,
          userId,
          role: invitation.role,
          createdAt: new Date("2026-08-18T02:00:00Z"),
        };
        members.push(member);
        // Better Auth runs the configured afterAcceptInvitation hook here.
        await syncMemberRole(
          prisma as never,
          invitation.organizationId,
          userId,
          member.role,
          member.role,
        );
      },
      cancelInvitation: async ({
        body,
      }: {
        body: { invitationId: string };
      }) => {
        const invitation = invitations.find(
          ({ id }) => id === body.invitationId,
        )!;
        invitation.status = "canceled";
      },
      updateMemberRole: async ({
        body,
      }: {
        body: { memberId: string; role: string; organizationId: string };
      }) => {
        const member = members.find(
          ({ id, organizationId }) =>
            id === body.memberId && organizationId === body.organizationId,
        )!;
        member.role = body.role;
      },
      removeMember: async ({
        body,
      }: {
        body: { memberIdOrEmail: string; organizationId: string };
      }) => {
        const index = members.findIndex(
          ({ id, organizationId }) =>
            id === body.memberIdOrEmail &&
            organizationId === body.organizationId,
        );
        members.splice(index, 1);
      },
    },
  };

  const app = new Hono<AppEnvironment>();
  app.use("*", async (context, next) => {
    context.set("orgId", "org_123");
    context.set("userId", context.req.header("x-user-id") ?? "user_admin");
    context.set("services", { prisma, auth } as never);
    context.set("audit", async () => undefined);
    await next();
  });
  app.route("/v1/orgs/:orgId/members", memberRouter);
  app.route("/v1/orgs/:orgId/invitations", invitationRouter);

  return { app, invitations, members, rules };
}

function jsonRequest(
  method: string,
  body: unknown,
  userId = "user_admin",
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", "x-user-id": userId },
    body: JSON.stringify(body),
  };
}

describe("organization members and invitations", () => {
  test("members can read the directory but cannot administer membership", async () => {
    const { app, members, rules } = createFixture();
    const membersPath = "/v1/orgs/org_123/members";
    members.push({
      id: "member_agent",
      organizationId: "org_123",
      userId: "user_agent",
      role: "member",
      createdAt: new Date("2026-08-18T02:00:00Z"),
    });
    rules.push({
      id: 3,
      orgId: "org_123",
      ptype: "g",
      v0: "user_agent",
      v1: "org:org_123:user:member",
      v2: null,
    });
    const memberHeaders = { "x-user-id": "user_agent" };

    const directory = await app.request(membersPath, {
      headers: memberHeaders,
    });
    expect(directory.status).toBe(200);
    expect(await directory.json()).toMatchObject({
      members: [
        { email: "admin@example.com", member_role: "admin" },
        { email: "agent@example.com", member_role: "member" },
      ],
    });

    const [invite, changeRole, remove] = await Promise.all([
      app.request(
        "/v1/orgs/org_123/invitations",
        jsonRequest("POST", { email: "new@example.com" }, "user_agent"),
      ),
      app.request(
        `${membersPath}/member_admin/role`,
        jsonRequest("PATCH", { role: "member" }, "user_agent"),
      ),
      app.request(`${membersPath}/member_admin`, {
        method: "DELETE",
        headers: memberHeaders,
      }),
    ]);
    expect(invite.status).toBe(403);
    expect(changeRole.status).toBe(403);
    expect(remove.status).toBe(403);
  });

  test("invites a user, accepts the invitation, and synchronizes role changes", async () => {
    const { app } = createFixture();
    const invitationsPath = "/v1/orgs/org_123/invitations";
    const membersPath = "/v1/orgs/org_123/members";

    const createResponse = await app.request(
      invitationsPath,
      jsonRequest("POST", { email: "agent@example.com", role: "member" }),
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { invitation_id: string };

    const listInvitations = await app.request(invitationsPath);
    expect(listInvitations.status).toBe(200);
    expect(await listInvitations.json()).toMatchObject({
      invitations: [{ id: created.invitation_id, role: "member" }],
    });

    const acceptResponse = await app.request(
      `${invitationsPath}/accept`,
      jsonRequest(
        "POST",
        { invitation_id: created.invitation_id },
        "user_agent",
      ),
    );
    expect(acceptResponse.status).toBe(200);

    const memberList = await app.request(membersPath);
    expect(memberList.status).toBe(200);
    const listed = (await memberList.json()) as {
      members: Array<Record<string, unknown>>;
    };
    expect(
      listed.members.find(({ user_id }) => user_id === "user_agent"),
    ).toMatchObject({
      member_id: "member_agent",
      user_id: "user_agent",
      member_role: "member",
      casbin_roles: ["member"],
    });

    const roleResponse = await app.request(
      `${membersPath}/member_agent/role`,
      jsonRequest("PATCH", { role: "admin" }),
    );
    expect(roleResponse.status).toBe(200);

    const updatedList = await app.request(membersPath);
    const updated = (await updatedList.json()) as {
      members: Array<Record<string, unknown>>;
    };
    expect(
      updated.members.find(({ user_id }) => user_id === "user_agent"),
    ).toMatchObject({
      member_id: "member_agent",
      user_id: "user_agent",
      member_role: "admin",
      casbin_roles: ["admin"],
    });
  });

  test("cancels pending invitations and removes member Casbin access", async () => {
    const { app, invitations, members, rules } = createFixture();
    const invitationsPath = "/v1/orgs/org_123/invitations";
    const membersPath = "/v1/orgs/org_123/members";

    const createResponse = await app.request(
      invitationsPath,
      jsonRequest("POST", { email: "agent@example.com" }),
    );
    const created = (await createResponse.json()) as { invitation_id: string };
    expect(
      (
        await app.request(
          `${invitationsPath}/cancel`,
          jsonRequest("POST", { invitation_id: created.invitation_id }),
        )
      ).status,
    ).toBe(200);
    expect(invitations[0]?.status).toBe("canceled");

    members.push({
      id: "member_agent",
      organizationId: "org_123",
      userId: "user_agent",
      role: "member",
      createdAt: new Date(),
    });
    rules.push(
      {
        id: 10,
        orgId: "org_123",
        ptype: "g",
        v0: "user_agent",
        v1: "org:org_123:user:member",
        v2: null,
      },
      {
        id: 11,
        orgId: "org_123",
        ptype: "p",
        v0: "user_agent",
        v1: "/collections/tasks",
        v2: "read",
      },
    );

    const removeResponse = await app.request(`${membersPath}/member_agent`, {
      method: "DELETE",
      headers: { "x-user-id": "user_admin" },
    });
    expect(removeResponse.status).toBe(200);
    expect(members.some(({ userId }) => userId === "user_agent")).toBe(false);
    expect(rules.some(({ v0 }) => v0 === "user_agent")).toBe(false);
  });
});

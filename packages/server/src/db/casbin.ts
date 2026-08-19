import type { Prisma, PrismaClient } from "@prisma/client";
import { newEnforcer, newModel, type Enforcer } from "casbin";

const CASBIN_MODEL = `
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[role_definition]
g = _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub) && keyMatch(r.obj, p.obj) && (r.act == p.act || p.act == "*")
`;

interface StoredRule {
  ptype: "p" | "g";
  v0: string;
  v1: string;
  v2: string | null;
}

async function addRule(
  prisma: PrismaClient,
  orgId: string,
  rule: StoredRule,
): Promise<boolean> {
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.casbinRule.findFirst({
      where: { orgId, ...rule },
      select: { id: true },
    });
    if (existing) return false;

    await transaction.casbinRule.create({ data: { orgId, ...rule } });
    return true;
  });
}

async function removeRule(
  prisma: PrismaClient,
  orgId: string,
  rule: StoredRule,
): Promise<boolean> {
  const result = await prisma.casbinRule.deleteMany({
    where: { orgId, ...rule },
  });
  return result.count > 0;
}

export function roleSubject(orgId: string, role: string): string {
  return `org:${orgId}:user:${role}`;
}

export async function createOrgEnforcer(
  prisma: PrismaClient,
  orgId: string,
): Promise<Enforcer> {
  const model = newModel();
  model.loadModelFromText(CASBIN_MODEL);
  const enforcer = await newEnforcer(model);
  const rules = await prisma.casbinRule.findMany({
    where: { orgId, ptype: { in: ["p", "g"] } },
    orderBy: { id: "asc" },
    select: { ptype: true, v0: true, v1: true, v2: true },
  });

  for (const rule of rules) {
    if (!rule.v0 || !rule.v1) continue;
    if (rule.ptype === "p" && rule.v2) {
      await enforcer.addPolicy(rule.v0, rule.v1, rule.v2);
    } else if (rule.ptype === "g") {
      await enforcer.addGroupingPolicy(rule.v0, rule.v1);
    }
  }

  return enforcer;
}

export async function hasPermission(
  prisma: PrismaClient,
  orgId: string,
  subject: string,
  resource: string,
  action: string,
): Promise<boolean> {
  const enforcer = await createOrgEnforcer(prisma, orgId);
  return enforcer.enforce(subject, resource, action);
}

export async function addPolicy(
  prisma: PrismaClient,
  orgId: string,
  subject: string,
  resource: string,
  action: string,
): Promise<boolean> {
  return addRule(prisma, orgId, {
    ptype: "p",
    v0: subject,
    v1: resource,
    v2: action,
  });
}

export async function removePolicy(
  prisma: PrismaClient,
  orgId: string,
  subject: string,
  resource: string,
  action: string,
): Promise<boolean> {
  return removeRule(prisma, orgId, {
    ptype: "p",
    v0: subject,
    v1: resource,
    v2: action,
  });
}

export async function assignRole(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  role: string,
): Promise<boolean> {
  return addRule(prisma, orgId, {
    ptype: "g",
    v0: userId,
    v1: roleSubject(orgId, role),
    v2: null,
  });
}

export async function unassignRole(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  role: string,
): Promise<boolean> {
  return removeRule(prisma, orgId, {
    ptype: "g",
    v0: userId,
    v1: roleSubject(orgId, role),
    v2: null,
  });
}

export async function syncMemberRole(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  previousRole: string,
  role: string,
): Promise<void> {
  if (previousRole !== role) {
    await unassignRole(prisma, orgId, userId, previousRole);
  }
  if (role === "member") {
    await addPolicy(prisma, orgId, roleSubject(orgId, role), "/*", "read");
  }
  await assignRole(prisma, orgId, userId, role);
}

export async function removeMemberAccess(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
): Promise<void> {
  await Promise.all([
    prisma.casbinRule.deleteMany({ where: { orgId, ptype: "g", v0: userId } }),
    prisma.casbinRule.deleteMany({ where: { orgId, ptype: "p", v0: userId } }),
  ]);
}

export async function bootstrapOrgPolicies(
  prisma: PrismaClient,
  orgId: string,
  adminUserId: string,
): Promise<void> {
  const role = roleSubject(orgId, "admin");
  const policies: readonly StoredRule[] = [
    { ptype: "p", v0: role, v1: "/*", v2: "*" },
    { ptype: "g", v0: adminUserId, v1: role, v2: null },
  ];

  await prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
    for (const policy of policies) {
      const existing = await transaction.casbinRule.findFirst({
        where: { orgId, ...policy },
        select: { id: true },
      });
      if (!existing) {
        await transaction.casbinRule.create({ data: { orgId, ...policy } });
      }
    }
  });
}

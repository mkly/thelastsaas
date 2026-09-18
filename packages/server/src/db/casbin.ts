import { cachedMetadata, policyCacheKey, invalidateMetadata } from "./cache";
import type { Prisma, PrismaClient } from "@prisma/client";
import { newEnforcer, newModel, Util, type Enforcer } from "casbin";

import {
  encodeGrantOptions,
  validateGrantOptions,
  type GrantOptions,
} from "./grant-options";

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
  v3?: string | null;
}

async function addRule(
  prisma: PrismaClient,
  orgId: string,
  rule: StoredRule,
): Promise<boolean> {
  try {
    return await prisma.$transaction(async (transaction) => {
      const existing = await transaction.casbinRule.findFirst({
        where: {
          orgId,
          ...rule,
          ...(rule.ptype === "p" ? { v3: rule.v3 ?? null } : {}),
        },
        select: { id: true },
      });
      if (existing) return false;

      await transaction.casbinRule.create({ data: { orgId, ...rule } });
      return true;
    });
  } finally {
    await invalidateMetadata(prisma, policyCacheKey(orgId));
  }
}

async function removeRule(
  prisma: PrismaClient,
  orgId: string,
  rule: StoredRule,
): Promise<boolean> {
  try {
    const result = await prisma.casbinRule.deleteMany({
      where: {
        orgId,
        ...rule,
        ...(rule.ptype === "p" ? { v3: rule.v3 ?? null } : {}),
      },
    });
    return result.count > 0;
  } finally {
    await invalidateMetadata(prisma, policyCacheKey(orgId));
  }
}

export function roleSubject(orgId: string, role: string): string {
  return `org:${orgId}:user:${role}`;
}

export function getOrgRules(prisma: PrismaClient, orgId: string) {
  return cachedMetadata(prisma, policyCacheKey(orgId), async () => {
    return prisma.casbinRule.findMany({
      where: { orgId, ptype: { in: ["p", "g"] } },
      orderBy: { id: "asc" },
      select: { ptype: true, v0: true, v1: true, v2: true, v3: true },
    });
  });
}

export async function createOrgEnforcer(
  prisma: PrismaClient,
  orgId: string,
): Promise<Enforcer> {
  const model = newModel();
  model.loadModelFromText(CASBIN_MODEL);
  const enforcer = await newEnforcer(model);
  const rules = await getOrgRules(prisma, orgId);

  for (const rule of rules) {
    if (!rule.v0 || !rule.v1) continue;
    if (rule.ptype === "p" && rule.v2 && !rule.v3) {
      await enforcer.addPolicy(rule.v0, rule.v1, rule.v2);
      if (rule.v2 === "write") {
        await enforcer.addPolicy(rule.v0, rule.v1, "create");
        await enforcer.addPolicy(rule.v0, rule.v1, "update");
      }
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

/** A resource-level check cannot authorize a particular record or field. */
export async function checkPermission(
  prisma: PrismaClient,
  orgId: string,
  subject: string,
  resource: string,
  action: string,
): Promise<{ allowed: boolean; conditional?: boolean }> {
  const enforcer = await createOrgEnforcer(prisma, orgId);
  if (await enforcer.enforce(subject, resource, action))
    return { allowed: true };
  const subjects = [
    subject,
    ...(await enforcer.getImplicitRolesForUser(subject)),
  ];
  const rules = await getOrgRules(prisma, orgId);
  const conditional = rules.some(
    (rule) =>
      rule.ptype === "p" &&
      rule.v3 &&
      rule.v0 &&
      subjects.includes(rule.v0) &&
      rule.v1 &&
      Util.keyMatchFunc(resource, rule.v1) &&
      (rule.v2 === action ||
        (rule.v2 === "write" && ["create", "update"].includes(action))),
  );
  return conditional
    ? { allowed: true, conditional: true }
    : { allowed: false };
}

export async function addPolicy(
  prisma: PrismaClient,
  orgId: string,
  subject: string,
  resource: string,
  action: string,
  options: GrantOptions = {},
): Promise<boolean> {
  await validateGrantOptions(prisma, orgId, resource, action, options);
  return addRule(prisma, orgId, {
    ptype: "p",
    v0: subject,
    v1: resource,
    v2: action,
    v3: encodeGrantOptions(options),
  });
}

export async function removePolicy(
  prisma: PrismaClient,
  orgId: string,
  subject: string,
  resource: string,
  action: string,
  options: GrantOptions = {},
): Promise<boolean> {
  return removeRule(prisma, orgId, {
    ptype: "p",
    v0: subject,
    v1: resource,
    v2: action,
    v3: encodeGrantOptions(options),
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
  await assignRole(prisma, orgId, userId, role);
}

export async function removeMemberAccess(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
): Promise<void> {
  try {
    await prisma.casbinRule.deleteMany({
      where: { orgId, ptype: { in: ["p", "g"] }, v0: userId },
    });
  } finally {
    await invalidateMetadata(prisma, policyCacheKey(orgId));
  }
}

export async function bootstrapOrgPolicies(
  prisma: PrismaClient,
  orgId: string,
  adminUserId: string,
): Promise<void> {
  try {
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
  } finally {
    await invalidateMetadata(prisma, policyCacheKey(orgId));
  }
}

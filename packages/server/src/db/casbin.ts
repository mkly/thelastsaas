import { cachedMetadata, policyCacheKey, invalidateMetadata } from "./cache";
import type { Prisma, PrismaClient } from "@prisma/client";
import { type Enforcer } from "casbin";

import { validatePolicyOptions, type PolicyOptions } from "./policy-options";
import { conditionalEnforcer, applicablePolicies } from "./conditional-policy";

interface StoredRule {
  ptype: "p" | "g";
  v0: string;
  v1: string;
  v2: string | null;
  v3?: string | null;
  v4?: string | null;
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
  return `org:${orgId}:role:${role}`;
}

export function getOrgRules(prisma: Prisma.TransactionClient, orgId: string) {
  return cachedMetadata(prisma, policyCacheKey(orgId), async () => {
    return prisma.casbinRule.findMany({
      where: { orgId, ptype: { in: ["p", "g"] } },
      orderBy: { id: "asc" },
      select: { ptype: true, v0: true, v1: true, v2: true, v3: true, v4: true },
    });
  });
}

export async function createOrgEnforcer(
  prisma: Prisma.TransactionClient,
  orgId: string,
): Promise<Enforcer> {
  const rules = await getOrgRules(prisma, orgId);
  return conditionalEnforcer(
    rules
      .filter(
        (rule) =>
          rule.ptype === "p" &&
          rule.v0 &&
          rule.v1 &&
          rule.v2 &&
          typeof rule.v3 === "string" &&
          typeof rule.v4 === "string",
      )
      .map((rule) => ({
        subject: rule.v0!,
        resource: rule.v1!,
        action: rule.v2!,
        cond: rule.v3!,
        msg: rule.v4!,
      })),
    rules
      .filter((rule) => rule.ptype === "g" && rule.v0 && rule.v1)
      .map((rule) => [rule.v0!, rule.v1!] as const),
  );
}

export async function hasPermission(
  prisma: Prisma.TransactionClient,
  orgId: string,
  subject: string,
  resource: string,
  action: string,
): Promise<boolean> {
  const enforcer = await createOrgEnforcer(prisma, orgId);
  const user = await prisma.user.findUnique({
    where: { id: subject },
    select: { email: true },
  });
  return enforcer.enforce(
    subject,
    { path: resource, data: {}, refs: {} },
    action,
    { data: {}, refs: {} },
    { id: subject, email: user?.email ?? "", org: orgId },
  );
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
  const policies = await applicablePolicies(
    enforcer,
    subject,
    resource,
    action,
  );
  return policies.some((policy) => policy.cond.trim() === "true")
    ? { allowed: true }
    : policies.length
      ? { allowed: true, conditional: true }
      : { allowed: false };
}

export async function addPolicy(
  prisma: PrismaClient,
  orgId: string,
  subject: string,
  resource: string,
  action: string,
  options: PolicyOptions = {},
): Promise<boolean> {
  await validatePolicyOptions(prisma, orgId, resource, action, options);
  return addRule(prisma, orgId, {
    ptype: "p",
    v0: subject,
    v1: resource,
    v2: action,
    v3: options.cond ?? "true",
    v4: options.msg ?? "",
  });
}

export async function removePolicy(
  prisma: PrismaClient,
  orgId: string,
  subject: string,
  resource: string,
  action: string,
  options: PolicyOptions = {},
): Promise<boolean> {
  return removeRule(prisma, orgId, {
    ptype: "p",
    v0: subject,
    v1: resource,
    v2: action,
    v3: options.cond ?? "true",
    v4: options.msg ?? "",
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
      { ptype: "p", v0: role, v1: "/*", v2: "*", v3: "true", v4: "" },
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

/** Rules relevant to the caller, including independent field policies. */
export async function describeCollectionPolicies(
  db: Prisma.TransactionClient,
  orgId: string,
  subject: string,
  name: string,
) {
  const enforcer = await createOrgEnforcer(db, orgId);
  const collection = await db.collection.findFirstOrThrow({
    where: { orgId, name },
    select: { schema: true },
  });
  const paths = [
    `/collections/${name}`,
    ...Object.keys(collection.schema as object).map(
      (field) => `/collections/${name}/fields/${field}`,
    ),
  ];
  const policies = (
    await Promise.all(
      paths.flatMap((path) =>
        ["read", "create", "update", "delete", "manage"].map((action) =>
          applicablePolicies(enforcer, subject, path, action),
        ),
      ),
    )
  ).flat();
  return [
    ...new Map(
      policies.map((policy) => [JSON.stringify(policy), policy]),
    ).values(),
  ];
}

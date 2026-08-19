import {
  InvalidQueryError,
  genId,
  isPlainObject,
  type Where,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { Util, type Enforcer } from "casbin";

import { substitute, type Principal } from "./query/compile";

function jsonObject(value: Where): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

/**
 * Resolve the row restriction for the roles that grant this collection action.
 * Any unfiltered granting role wins, preserving normal additive RBAC semantics.
 */
export async function getRowFilter(
  prisma: PrismaClient,
  enforcer: Enforcer,
  principal: Principal,
  collectionId: string,
  resource: string,
  action: string,
  resolveEmail?: () => Promise<string>,
): Promise<Where | null> {
  const rolePrefix = `org:${principal.orgId}:user:`;
  const directGrant = (
    await enforcer.getPermissionsForUser(principal.userId)
  ).some(
    (policy) =>
      policy[1] !== undefined &&
      policy[2] !== undefined &&
      Util.keyMatchFunc(resource, policy[1]) &&
      (policy[2] === action || policy[2] === "*"),
  );
  if (directGrant) return null;

  const roles = (await enforcer.getRolesForUser(principal.userId))
    .filter((role) => role.startsWith(rolePrefix))
    .map((role) => role.slice(rolePrefix.length));

  const grantingRoles: string[] = [];
  for (const role of roles) {
    if (await enforcer.enforce(`${rolePrefix}${role}`, resource, action)) {
      grantingRoles.push(role);
    }
  }

  // If no role independently grants the action, the already-successful Casbin
  // gate came from another unconditional path.
  if (grantingRoles.length === 0) return null;

  const rows = await prisma.rowFilter.findMany({
    where: {
      orgId: principal.orgId,
      collectionId,
      action,
      role: { in: grantingRoles },
    },
    select: { role: true, condition: true },
  });

  if (rows.length < grantingRoles.length) return null;

  const conditions = rows.map(({ condition, role }) => {
    if (!isPlainObject(condition)) {
      throw new InvalidQueryError(
        `Stored row filter for role '${role}' is not a Where object`,
      );
    }
    return condition as Where;
  });
  const composed: Where =
    conditions.length === 1 ? conditions[0]! : { or: conditions };

  let resolvedPrincipal = principal;
  if (resolveEmail && JSON.stringify(composed).includes("$user.email")) {
    resolvedPrincipal = {
      ...principal,
      userEmail: await resolveEmail(),
    };
  }
  return substitute(composed, resolvedPrincipal);
}

export async function setRowFilter(
  prisma: PrismaClient,
  orgId: string,
  collectionId: string,
  role: string,
  action: string,
  condition: Where,
): Promise<{ id: string }> {
  const row = await prisma.rowFilter.upsert({
    where: {
      orgId_collectionId_role_action: { orgId, collectionId, role, action },
    },
    create: {
      id: genId(),
      orgId,
      collectionId,
      role,
      action,
      condition: jsonObject(condition),
    },
    update: { condition: jsonObject(condition) },
    select: { id: true },
  });
  return row;
}

export async function deleteRowFilter(
  prisma: PrismaClient,
  orgId: string,
  id: string,
): Promise<boolean> {
  const result = await prisma.rowFilter.deleteMany({ where: { id, orgId } });
  return result.count > 0;
}

export async function listRowFilters(
  prisma: PrismaClient,
  orgId: string,
  collectionId?: string,
) {
  return prisma.rowFilter.findMany({
    where: collectionId ? { orgId, collectionId } : { orgId },
    orderBy: { createdAt: "desc" },
    include: { collection: { select: { name: true } } },
  });
}

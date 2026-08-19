import {
  FieldPermissionDeniedError,
  InvalidQueryError,
  genId,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { Util, type Enforcer } from "casbin";

import type { Principal } from "./query/compile";

export interface ResolvedFieldFilter {
  readableFields: ReadonlySet<string>;
  writableFields: ReadonlySet<string>;
}

const RECORD_METADATA_FIELDS = new Set([
  "id",
  "created_by",
  "created_at",
  "updated_at",
]);

function jsonArray(values: string[]): Prisma.InputJsonArray {
  return [...values];
}

function storedFields(
  value: Prisma.JsonValue,
  role: string,
  kind: "readable" | "writable",
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((field) => typeof field !== "string")
  ) {
    throw new InvalidQueryError(
      `Stored ${kind} field filter for role '${role}' is not a string array`,
    );
  }
  return value as string[];
}

/**
 * Resolve the union of fields granted by every filtered role that grants the
 * action. A direct grant or any unfiltered granting role keeps normal additive
 * RBAC semantics and leaves field access unrestricted.
 */
export async function getFieldFilter(
  prisma: PrismaClient,
  enforcer: Enforcer,
  principal: Principal,
  collectionId: string,
  resource: string,
  action: string,
): Promise<ResolvedFieldFilter | null> {
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
  if (grantingRoles.length === 0) return null;

  const rows = await prisma.fieldFilter.findMany({
    where: {
      orgId: principal.orgId,
      collectionId,
      action,
      role: { in: grantingRoles },
    },
    select: { role: true, readableFields: true, writableFields: true },
  });
  if (rows.length < grantingRoles.length) return null;

  const readableFields = new Set<string>();
  const writableFields = new Set<string>();
  for (const row of rows) {
    for (const field of storedFields(
      row.readableFields,
      row.role,
      "readable",
    )) {
      readableFields.add(field);
    }
    for (const field of storedFields(
      row.writableFields,
      row.role,
      "writable",
    )) {
      writableFields.add(field);
    }
  }
  return { readableFields, writableFields };
}

export function isFieldReadable(
  field: string,
  filter?: ResolvedFieldFilter | null,
): boolean {
  return (
    !filter ||
    RECORD_METADATA_FIELDS.has(field) ||
    filter.readableFields.has(field)
  );
}

export function filterReadableData(
  data: Record<string, unknown>,
  filter?: ResolvedFieldFilter | null,
): Record<string, unknown> {
  if (!filter) return data;
  return Object.fromEntries(
    Object.entries(data).filter(([field]) => filter.readableFields.has(field)),
  );
}

export function assertWritableFields(
  data: Record<string, unknown>,
  filter?: ResolvedFieldFilter | null,
): void {
  if (!filter) return;
  const denied = Object.keys(data).filter(
    (field) => !filter.writableFields.has(field),
  );
  if (denied.length > 0) throw new FieldPermissionDeniedError(denied);
}

export async function setFieldFilter(
  prisma: PrismaClient,
  orgId: string,
  collectionId: string,
  role: string,
  action: string,
  readableFields: string[],
  writableFields: string[],
): Promise<{ id: string }> {
  return prisma.fieldFilter.upsert({
    where: {
      orgId_collectionId_role_action: { orgId, collectionId, role, action },
    },
    create: {
      id: genId(),
      orgId,
      collectionId,
      role,
      action,
      readableFields: jsonArray(readableFields),
      writableFields: jsonArray(writableFields),
    },
    update: {
      readableFields: jsonArray(readableFields),
      writableFields: jsonArray(writableFields),
    },
    select: { id: true },
  });
}

export async function deleteFieldFilter(
  prisma: PrismaClient,
  orgId: string,
  id: string,
): Promise<boolean> {
  const result = await prisma.fieldFilter.deleteMany({ where: { id, orgId } });
  return result.count > 0;
}

export async function listFieldFilters(
  prisma: PrismaClient,
  orgId: string,
  collectionId?: string,
) {
  return prisma.fieldFilter.findMany({
    where: collectionId ? { orgId, collectionId } : { orgId },
    orderBy: { createdAt: "desc" },
    include: { collection: { select: { name: true } } },
  });
}

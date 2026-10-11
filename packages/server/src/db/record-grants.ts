import type { Prisma } from "@prisma/client";
import type { Where } from "@lastsaas/shared";
import { roleSubject } from "./casbin";
import { substitute, type Principal } from "./query/compile";
import { resolveResourceGrants, type ResourceGrants } from "./resource-grants";

// Preserve the collection API while sharing policy matching and SQL evaluation.
export * from "./resource-grants";
export type {
  ResourceGrant as RecordGrant,
  ResourceGrants as RecordGrants,
} from "./resource-grants";

export async function resolveRecordGrants(
  prisma: Prisma.TransactionClient,
  principal: Principal,
  collectionId: string,
  resource: string,
  action: string,
): Promise<ResourceGrants> {
  const [rows, fields] = await Promise.all([
    prisma.rowFilter.findMany({
      where: { orgId: principal.orgId, collectionId },
    }),
    prisma.fieldFilter.findMany({
      where: { orgId: principal.orgId, collectionId },
    }),
  ]);
  const prefix = roleSubject(principal.orgId, "");
  return resolveResourceGrants(
    prisma,
    principal,
    resource,
    action,
    (subject) => {
      const role = subject.startsWith(prefix)
        ? subject.slice(prefix.length)
        : undefined;
      const legacyAction =
        action === "create" || action === "update" ? "write" : action;
      const row =
        role === undefined || action === "create"
          ? undefined
          : rows.find((r) => r.role === role && r.action === legacyAction);
      const field =
        role === undefined
          ? undefined
          : fields.find((f) => f.role === role && f.action === legacyAction);
      return {
        where: row ? substitute(row.condition as Where, principal) : undefined,
        readable: field ? (field.readableFields as string[]) : undefined,
        writable: field ? (field.writableFields as string[]) : undefined,
        checkAfter: false,
      };
    },
  );
}

import {
  InvalidQueryError,
  PermissionDeniedError,
  FieldPermissionDeniedError,
  type Schema,
  type Where,
} from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import type { Enforcer } from "casbin";
import { createOrgEnforcer } from "./casbin";
import { applicablePolicies, enforceRuleWrite } from "./conditional-policy";
import { collectionReadScope } from "./conditional-read";
import { compileRule, loadRuleObjects, type RuleContext } from "./rule-context";
import type { Principal, DbProvider } from "./query/compile";
import type { FieldAccess } from "./field-access";

export const metadataFields = new Set([
  "id",
  "created_by",
  "created_at",
  "updated_at",
]);
export interface AccessRecord {
  id: string;
  data: unknown;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
interface AccessContext {
  principal: Principal;
  path: string;
  action: string;
  enforcer: Enforcer;
  readable: string[];
  writable: string[];
  scope?: Where;
}
export type CollectionAccess = AccessContext[];
const caller = (principal: Principal): RuleContext["usr"] => ({
  id: principal.userId,
  email: principal.userEmail,
  org: principal.orgId,
});

export async function resolveCollectionAccess(
  db: Prisma.TransactionClient,
  principal: Principal,
  collectionId: string,
  resource: string,
  action: string,
): Promise<CollectionAccess> {
  const enforcer = await createOrgEnforcer(db, principal.orgId);
  if (
    !(await applicablePolicies(enforcer, principal.userId, resource, action))
      .length
  )
    return [];
  const collection = await db.collection.findFirstOrThrow({
    where: { orgId: principal.orgId, id: collectionId },
  });
  const schema = collection.schema as Schema;
  const fields = Object.keys(schema);
  const requests = (fieldAction: string) =>
    fields.map((field) => [
      principal.userId,
      { path: `${resource}/fields/${field}`, data: {}, refs: {} },
      fieldAction,
      { data: {}, refs: {} },
      caller(principal),
    ]);
  const readScope =
    action === "read"
      ? await collectionReadScope(db, enforcer, caller(principal), {
          ...collection,
          schema,
        })
      : undefined;
  const read = readScope ? [] : await enforcer.batchEnforce(requests("read"));
  const write =
    action === "read" ? [] : await enforcer.batchEnforce(requests(action));
  const writable =
    action === "read"
      ? [...readScope!.readableFields]
      : fields.filter((_, index) => write[index]);
  const readable = readScope
    ? [...readScope.readableFields]
    : fields.filter((_, index) => read[index]);
  return [
    {
      principal,
      path: resource,
      action,
      enforcer,
      readable,
      writable,
      scope: readScope?.where,
    },
  ];
}
export function accessScope(access: CollectionAccess): Where {
  return access.length ? (access[0]!.scope ?? {}) : { id: { in: [] } };
}
export function queryAccessScope(
  access: CollectionAccess,
  fields: Set<string>,
): Where {
  for (const field of fields)
    if (
      !metadataFields.has(field) &&
      !access.some((a) => a.readable.includes(field))
    )
      throw new InvalidQueryError(
        `Field '${field}' is not allowed in this query`,
      );
  return accessScope(access);
}
export function projectAccess(access: CollectionAccess): FieldAccess {
  return {
    readableFields: new Set(access.flatMap((a) => a.readable)),
    writableFields: new Set(access.flatMap((a) => a.writable)),
  };
}
async function ruleContext(
  db: Prisma.TransactionClient,
  access: AccessContext,
  schema: Schema,
  before: Record<string, unknown>,
  next: Record<string, unknown>,
  enforcer: Enforcer,
) {
  const policies = await applicablePolicies(
    enforcer,
    access.principal.userId,
    access.path,
    access.action,
  );
  const refs = new Set(
    policies.flatMap((policy) => [
      ...compileRule(policy.cond, schema).references,
    ]),
  );
  const [obj, proposed] = await loadRuleObjects(
    db,
    access.principal.orgId,
    schema,
    [before, next],
    refs,
  );
  return {
    obj: { ...obj!, path: access.path },
    next: proposed!,
    usr: caller(access.principal),
  };
}
export async function checkRecordAccess(
  db: Prisma.TransactionClient,
  access: CollectionAccess,
  row: AccessRecord,
  schema: Schema,
  _provider?: DbProvider,
): Promise<boolean[]> {
  return Promise.all(
    access.map(async (entry) => {
      const data = row.data as Record<string, unknown>;
      const context = await ruleContext(
        db,
        entry,
        schema,
        data,
        data,
        entry.enforcer,
      );
      return entry.enforcer.enforce(
        entry.principal.userId,
        context.obj,
        entry.action,
        context.next,
        context.usr,
      );
    }),
  );
}
export async function enforceRecordChange(
  db: Prisma.TransactionClient,
  access: CollectionAccess,
  schema: Schema,
  before: Record<string, unknown> | null,
  next: Record<string, unknown>,
  fields: string[],
): Promise<FieldAccess> {
  const entry = access[0];
  if (!entry) throw new PermissionDeniedError();
  // Resolve current policies in the transaction that owns the mutation.
  const enforcer = await createOrgEnforcer(db, entry.principal.orgId);
  const context = await ruleContext(
    db,
    entry,
    schema,
    before ?? {},
    next,
    enforcer,
  );
  await enforceRuleWrite(
    enforcer,
    entry.principal.userId,
    entry.action,
    context,
  );
  const permitted = await enforcer.batchEnforce(
    fields.map((field) => [
      entry.principal.userId,
      { path: `${entry.path}/fields/${field}`, data: {}, refs: {} },
      entry.action,
      { data: {}, refs: {} },
      context.usr,
    ]),
  );
  const denied = fields.filter((_, i) => !permitted[i]);
  if (denied.length) throw new FieldPermissionDeniedError(denied);
  const readable = await enforcer.batchEnforce(
    Object.keys(schema).map((field) => [
      entry.principal.userId,
      { path: `${entry.path}/fields/${field}`, data: {}, refs: {} },
      "read",
      { data: {}, refs: {} },
      context.usr,
    ]),
  );
  return {
    readableFields: new Set(
      Object.keys(schema).filter((_, index) => readable[index]),
    ),
    writableFields: new Set(fields),
  };
}

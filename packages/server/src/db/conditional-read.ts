import type { Prisma } from "@prisma/client";
import type { Enforcer } from "casbin";
import type { Schema, Where } from "@lastsaas/shared";
import { applicablePolicies, allowedRuleRows } from "./conditional-policy";
import { compileRule, loadRuleObjects, type RuleContext } from "./rule-context";

/** Return a SQL input scope before pagination/count/aggregation, plus independent
 * field access. Unconditional policies avoid fetching or evaluating any rows. */
export async function collectionReadScope(
  db: Prisma.TransactionClient,
  enforcer: Enforcer,
  caller: RuleContext["usr"],
  collection: { id: string; name: string; schema: Schema },
): Promise<{ where: Where | undefined; readableFields: ReadonlySet<string> }> {
  const path = `/collections/${collection.name}`;
  const policies = await applicablePolicies(enforcer, caller.id, path, "read");
  const fields = Object.keys(collection.schema);
  const fieldResults = await enforcer.batchEnforce(
    fields.map((field) => [
      caller.id,
      { path: `${path}/fields/${field}`, data: {}, refs: {} },
      "read",
      { data: {}, refs: {} },
      caller,
    ]),
  );
  const readableFields = new Set(
    fields.filter((_, index) => fieldResults[index]),
  );
  if (!policies.length) return { where: { id: { in: [] } }, readableFields };
  if (policies.some((policy) => policy.cond.trim() === "true"))
    return { where: undefined, readableFields };
  const refs = new Set(
    policies.flatMap((policy) => [
      ...compileRule(policy.cond, collection.schema).references,
    ]),
  );
  const rows = await db.record.findMany({
    where: { orgId: caller.org, collectionId: collection.id },
    select: { id: true, data: true },
  });
  const objects = await loadRuleObjects(
    db,
    caller.org,
    collection.schema,
    rows.map((row) => row.data as Record<string, unknown>),
    refs,
  );
  const allowed = await allowedRuleRows(
    enforcer,
    caller.id,
    "read",
    objects.map((object) => ({
      obj: { ...object, path },
      next: object,
      usr: caller,
    })),
  );
  return {
    where: {
      id: {
        in: rows.filter((_, index) => allowed[index]).map((row) => row.id),
      },
    },
    readableFields,
  };
}

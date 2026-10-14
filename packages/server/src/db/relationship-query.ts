import {
  extractFieldType,
  InvalidQueryError,
  isPlainObject,
  type Schema,
  type Where,
} from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import {
  compileWhere,
  applyOrgScope,
  relationshipPredicateKey,
  type DbProvider,
  type Principal,
} from "./query/compile";
import { sql, type SqlFragment } from "./query/kysely";
import { queryGrantWhere, resolveRecordGrants } from "./record-grants";

/** Resolve target permissions once, then compile relational filters into scoped SQL subqueries. */
export async function relationshipPredicates(
  db: Prisma.TransactionClient,
  provider: DbProvider,
  orgId: string,
  schema: Schema,
  where: Where | undefined,
  principal?: Principal,
  depth = 0,
): Promise<Map<string, SqlFragment>> {
  if (depth > 4)
    throw new InvalidQueryError("Relationship filter depth exceeds 4");
  const predicates = new Map<string, SqlFragment>();
  let count = 0;
  async function visit(node: Where | undefined): Promise<void> {
    if (!node) return;
    if (++count > 100)
      throw new InvalidQueryError("Relationship query is too complex");
    if (Array.isArray(node.and)) {
      for (const child of node.and) await visit(child);
      return;
    }
    if (Array.isArray(node.or)) {
      for (const child of node.or) await visit(child);
      return;
    }
    if (isPlainObject(node.not)) {
      await visit(node.not as Where);
      return;
    }
    for (const [field, condition] of Object.entries(node)) {
      if (!isPlainObject(condition)) continue;
      for (const operator of ["some", "none", "every"]) {
        if (!Object.hasOwn(condition, operator)) continue;
        const type = extractFieldType(schema[field]!);
        if (!type?.startsWith("ref:") || !principal)
          throw new InvalidQueryError(
            "Relationship filters require a reference field and authenticated principal",
          );
        const target = await db.collection.findUnique({
          where: { orgId_name: { orgId, name: type.slice(4) } },
        });
        if (!target)
          throw new InvalidQueryError(
            "Reference target collection is unavailable",
          );
        const nested = condition[operator] as Where;
        const targetSchema = target.schema as Schema;
        const grants = await resolveRecordGrants(
          db,
          principal,
          target.id,
          `/collections/${target.name}`,
          "read",
        );
        const children = await relationshipPredicates(
          db,
          provider,
          orgId,
          targetSchema,
          nested,
          principal,
          depth + 1,
        );
        const fields = new Set<string>();
        const filter = compileWhere(nested, targetSchema, provider, {
          relationshipPredicates: children,
          isFieldAllowed: (field) => {
            fields.add(field);
            return true;
          },
        });
        if (filter.postFilters.length)
          throw new InvalidQueryError(
            "Recurrence expansion cannot be used inside a relationship predicate",
          );
        const permitted = compileWhere(
          queryGrantWhere(grants, fields),
          targetSchema,
          provider,
        );
        if (permitted.postFilters.length)
          throw new InvalidQueryError(
            "Deferred permission conditions are unsupported",
          );
        const matches = filter.expression ?? sql`1=1`;
        const selected =
          operator === "every"
            ? sql`NOT COALESCE((${matches}), FALSE)`
            : matches;
        const scope = applyOrgScope(
          orgId,
          target.id,
          sql`(${permitted.expression ?? sql`1=1`}) AND (${selected})`,
        );
        const sources = sql`SELECT source_id FROM record_references WHERE org_id = ${orgId} AND field = ${field} AND target_id IN (SELECT id FROM records WHERE ${scope})`;
        predicates.set(
          relationshipPredicateKey(field, operator, nested),
          operator === "some"
            ? sql`id IN (${sources})`
            : sql`id NOT IN (${sources})`,
        );
      }
    }
  }
  await visit(where);
  return predicates;
}

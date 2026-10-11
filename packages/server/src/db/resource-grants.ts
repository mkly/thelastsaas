import { sql, queryRows } from "./query/kysely";
import { queryAdapter } from "./query/adapters";
import {
  FieldPermissionDeniedError,
  InvalidQueryError,
  PermissionDeniedError,
  type Schema,
  type Where,
} from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import { Util } from "casbin";
import { createOrgEnforcer, getOrgRules } from "./casbin";
import { decodeGrantOptions } from "./grant-options";
import {
  compileWhere,
  substitute,
  type DbProvider,
  type Principal,
  type CompileOptions,
} from "./query/compile";
import type { ResolvedFieldFilter } from "./fieldFilters";

export interface ResourceGrant {
  where?: Where;
  readable?: string[];
  writable?: string[];
  /** Legacy role filters did not check the proposed row. */
  checkAfter: boolean;
}
export type ResourceGrants = ResourceGrant[];
export const metadataFields = new Set([
  "id",
  "created_by",
  "created_at",
  "updated_at",
]);

export async function resolveResourceGrants(
  prisma: Prisma.TransactionClient,
  principal: Principal,
  resource: string,
  action: string,
  legacyGrant?: (subject: string, action: string) => ResourceGrant,
): Promise<ResourceGrants> {
  const enforcer = await createOrgEnforcer(prisma, principal.orgId);
  const roles = await enforcer.getImplicitRolesForUser(principal.userId);
  const subjects = [principal.userId, ...roles];
  const policies = await getOrgRules(prisma, principal.orgId);
  const grants: ResourceGrants = [];
  const legacyAction =
    action === "create" || action === "update" ? "write" : action;
  for (const policy of policies) {
    if (policy.ptype !== "p" || !policy.v0 || !subjects.includes(policy.v0))
      continue;
    if (
      !policy.v1 ||
      !Util.keyMatchFunc(resource, policy.v1) ||
      !(policy.v2 === "*" || policy.v2 === action || policy.v2 === legacyAction)
    )
      continue;
    if (policy.v3) {
      const options = decodeGrantOptions(policy.v3);
      grants.push({
        where: options.where && substitute(options.where, principal),
        readable: options.fields,
        writable: options.fields,
        checkAfter: true,
      });
    } else {
      grants.push(legacyGrant?.(policy.v0, action) ?? { checkAfter: true });
    }
  }
  return grants;
}

export function grantWhere(grants: ResourceGrants): Where {
  if (!grants.length) return { id: { in: [] } };
  if (grants.some((g) => !g.where || !Object.keys(g.where).length)) return {};
  return { or: grants.map((g) => g.where!) };
}

/** Every query-referenced field must be readable on the rows entering SQL,
 * including count, sort and aggregate inputs, so hidden values cannot leak. */
export function queryGrantWhere(
  grants: ResourceGrants,
  fields: Set<string>,
): Where {
  const conditions = [grantWhere(grants)];
  for (const field of fields) {
    if (metadataFields.has(field)) continue;
    const allowed = grants.filter(
      (g) => g.readable === undefined || g.readable.includes(field),
    );
    if (!allowed.length)
      throw new InvalidQueryError(
        `Field '${field}' is not allowed in this query`,
      );
    conditions.push(grantWhere(allowed));
  }
  return { and: conditions };
}

export function grantProjection(
  grants: ResourceGrants,
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions = {},
) {
  return grants.map((grant, i) => {
    const compiled = compileWhere(grant.where, schema, provider, options);
    if (compiled.postFilters.length)
      throw new InvalidQueryError(
        "Deferred recurrence conditions are not supported in permission grants",
      );
    return sql<number>`CASE WHEN ${compiled.expression ?? sql`1=1`} THEN 1 ELSE 0 END`.as(
      `grant_${i}`,
    );
  });
}

export function matchingGrants(
  grants: ResourceGrants,
  row: object,
): ResourceGrants {
  return grants.filter((_, i) =>
    Boolean((row as Record<string, unknown>)[`grant_${i}`]),
  );
}
export function grantFieldFilter(
  grants: ResourceGrants,
): ResolvedFieldFilter | null {
  if (grants.some((g) => g.readable === undefined)) return null;
  return {
    readableFields: new Set(grants.flatMap((g) => g.readable ?? [])),
    writableFields: new Set(grants.flatMap((g) => g.writable ?? [])),
  };
}

export interface GrantRecord {
  id: string;
  data: unknown;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
/** Evaluate proposed rows with the same SQL compiler used for stored rows. */
export async function evaluateGrants(
  prisma: Prisma.TransactionClient,
  grants: ResourceGrants,
  row: GrantRecord,
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions = {},
): Promise<boolean[]> {
  if (!grants.length) return [];
  const projection = grantProjection(grants, schema, provider, options);
  const adapter = queryAdapter(provider);
  const result = await queryRows<Record<string, unknown>>(
    prisma,
    provider,
    sql`SELECT ${sql.join(projection)} FROM (SELECT ${row.id} AS id,
      ${adapter.candidateJson(row.data)} AS data, ${row.createdBy} AS created_by,
      ${adapter.candidateTimestamp(row.createdAt)} AS created_at,
      ${adapter.candidateTimestamp(row.updatedAt)} AS updated_at) AS candidate`,
  );
  return grants.map((_, i) => Boolean(result[0]?.[`grant_${i}`]));
}
export function assertGrantedWrite(
  grants: ResourceGrants,
  before: boolean[],
  after: boolean[],
  fields: string[],
): ResourceGrants {
  const applicable = grants.filter(
    (g, i) => before[i] && (!g.checkAfter || after[i]),
  );
  if (!applicable.length)
    throw new PermissionDeniedError("No grant permits this record change");
  const denied = fields.filter(
    (field) =>
      !applicable.some(
        (g) => g.writable === undefined || g.writable.includes(field),
      ),
  );
  if (denied.length) throw new FieldPermissionDeniedError(denied);
  return applicable;
}

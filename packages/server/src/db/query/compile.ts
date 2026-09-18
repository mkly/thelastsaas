/**
 * Query compiler — the single place where the Where DSL becomes SQL.
 *
 * The compiler produces parameterized SQL for SQLite and PostgreSQL, applies
 * tenant scope, and exposes the policy seams used by row and field filters.
 * Recurrence expansion is intentionally deferred: `occurs_between` clauses
 * are returned as post-filter descriptors while the SQL remains a safe
 * candidate prefilter.
 */

import {
  InvalidQueryError,
  isPlainObject,
  isValidFieldName,
  type AggregateMetric,
  type AggregateRequest,
  type Schema,
  type Where,
  type WhereLeaf,
} from "@lastsaas/shared";

import { queryAdapter, type DbProvider } from "./adapters";
import { sql, type SqlFragment } from "./kysely";
export type { DbProvider } from "./adapters";

export type FieldReferenceKind =
  "where" | "order_by" | "group_by" | "metric" | "having";

export interface FieldReferenceContext {
  kind: FieldReferenceKind;
  /** The alias or request key that led to this schema-field reference. */
  reference: string;
}

/** Return false to reject access to a schema field in the given context. */
export type FieldAllowlist = (
  fieldName: string,
  context: FieldReferenceContext,
) => boolean;

export interface CompileOptions {
  /** Predicate injected by policy code and ANDed with the caller's predicate. */
  extraWhere?: Where | null;
  /** Field-filter hook. The compiler throws when this returns false. */
  isFieldAllowed?: FieldAllowlist;
  /** Internal recursion state: retain SQL UNKNOWN inside negated predicates. */
  preserveUnknown?: boolean;
}

export interface OccursBetweenPostFilter {
  kind: "occurs_between";
  field: string;
  start: string;
  end: string;
}

export type QueryPostFilter = OccursBetweenPostFilter;

export interface CompiledFragment {
  expression: SqlFragment | undefined;
  postFilters: QueryPostFilter[];
}

// ---------------------------------------------------------------------------
// Identifier and field safety
// ---------------------------------------------------------------------------

const RECORD_METADATA_TYPES: Readonly<Record<string, string>> = {
  id: "string",
  created_by: "string",
  created_at: "datetime",
  updated_at: "datetime",
};

/** Validate that a field is a safe record field or metadata column. */
export function validateField(fieldName: string, schema: Schema): void {
  if (!isValidFieldName(fieldName)) {
    throw new InvalidQueryError(`Invalid field name: '${fieldName}'`);
  }
  if (!(fieldName in schema) && !(fieldName in RECORD_METADATA_TYPES)) {
    throw new InvalidQueryError(`Unknown field '${fieldName}' (not in schema)`);
  }
}

function validateFieldReference(
  fieldName: string,
  schema: Schema,
  kind: FieldReferenceKind,
  options: CompileOptions,
  reference = fieldName,
): void {
  validateField(fieldName, schema);
  if (options.isFieldAllowed?.(fieldName, { kind, reference }) === false) {
    throw new InvalidQueryError(
      `Field '${fieldName}' is not allowed in ${kind.replaceAll("_", " ")}`,
    );
  }
}

const NUMERIC_TYPES = new Set(["number", "integer", "float"]);

function fieldType(fieldName: string, schema: Schema): string | undefined {
  if (fieldName in RECORD_METADATA_TYPES) {
    return RECORD_METADATA_TYPES[fieldName];
  }
  const definition = schema[fieldName];
  return typeof definition === "string" ? definition : definition?.type;
}

function isNumericField(fieldName: string, schema: Schema): boolean {
  const type = fieldType(fieldName, schema);
  return type !== undefined && NUMERIC_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Dialect helpers
// ---------------------------------------------------------------------------

/** Extract a JSON field or return a validated native metadata column. */
export function extractField(field: string, provider: DbProvider): SqlFragment {
  return field in RECORD_METADATA_TYPES
    ? sql.ref(field)
    : queryAdapter(provider).extract(field);
}

function numericExpr(
  expression: SqlFragment,
  provider: DbProvider,
): SqlFragment {
  return queryAdapter(provider).numeric(expression);
}

function comparisonExpr(
  field: string,
  schema: Schema,
  provider: DbProvider,
): SqlFragment {
  const expression = extractField(field, provider);
  const type = fieldType(field, schema);
  const adapter = queryAdapter(provider);
  if (type === "boolean") return adapter.boolean(expression);
  if (type && NUMERIC_TYPES.has(type)) return adapter.numeric(expression);
  return expression;
}

function comparisonParam(value: unknown, provider: DbProvider): unknown {
  return queryAdapter(provider).parameter(value);
}

function compileEquality(
  field: string,
  value: unknown,
  schema: Schema,
  provider: DbProvider,
  preserveUnknown = false,
): SqlFragment {
  const type = fieldType(field, schema);
  if (!(field in RECORD_METADATA_TYPES) && type !== "json" && value !== null) {
    const expected =
      type && NUMERIC_TYPES.has(type)
        ? "number"
        : type === "boolean"
          ? "boolean"
          : "string";
    if (
      typeof value !== expected ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new InvalidQueryError(
        `Field '${field}': equality requires a ${expected} value`,
      );
    }
    return queryAdapter(provider).equality(
      field,
      value as string | number | boolean,
      preserveUnknown,
    );
  }
  return sql`${comparisonExpr(field, schema, provider)} = ${comparisonParam(value, provider)}`;
}

// ---------------------------------------------------------------------------
// Org scoping
// ---------------------------------------------------------------------------

export function applyOrgScope(
  orgId: string,
  collectionId: string,
  expression?: SqlFragment,
): SqlFragment {
  const scope = sql`org_id = ${orgId} AND collection_id = ${collectionId}`;
  return expression ? sql`${scope} AND (${expression})` : scope;
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

export interface Principal {
  userId: string;
  userEmail: string;
  orgId: string;
}

const VARIABLE_TABLE: Record<string, keyof Principal> = {
  "$user.id": "userId",
  "$user.email": "userEmail",
  "$org.id": "orgId",
};

export function substitute(where: Where, principal: Principal): Where {
  return walk(where) as Where;

  function walk(node: unknown): unknown {
    if (typeof node === "string") return resolveString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (isPlainObject(node)) {
      return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [key, walk(value)]),
      );
    }
    return node;
  }

  function resolveString(value: string): string {
    if (!value.startsWith("$")) return value;
    const principalKey = VARIABLE_TABLE[value];
    if (!principalKey) {
      throw new InvalidQueryError(
        `Unknown substitution variable '${value}' (allowed: ${Object.keys(VARIABLE_TABLE).join(", ")})`,
      );
    }
    return principal[principalKey];
  }
}

// ---------------------------------------------------------------------------
// Where DSL -> SQL
// ---------------------------------------------------------------------------

export function compileWhere(
  where: Where | null | undefined,
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions = {},
): CompiledFragment {
  const requested = compileOptionalNode(where, schema, provider, options);
  // The injected predicate comes from policy code rather than from the caller,
  // so it is exempt from the caller's field allowlist: a row filter keyed on a
  // field the requester may not read must still narrow the result set instead
  // of failing the whole query.
  const injected = compileOptionalNode(
    options.extraWhere,
    schema,
    provider,
    {},
  );
  return andFragments(requested, injected);
}

function compileOptionalNode(
  node: Where | null | undefined,
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions,
): CompiledFragment {
  if (!node || (isPlainObject(node) && Object.keys(node).length === 0)) {
    return { expression: undefined, postFilters: [] };
  }
  return compileNode(node, schema, provider, options, true);
}

function andFragments(
  left: CompiledFragment,
  right: CompiledFragment,
): CompiledFragment {
  const postFilters = [...left.postFilters, ...right.postFilters];
  if (!left.expression) return { ...right, postFilters };
  if (!right.expression) return { ...left, postFilters };
  return {
    expression: sql`(${left.expression}) AND (${right.expression})`,
    postFilters,
  };
}

/**
 * `conjunctive` is false once compilation descends into an `or` branch or a
 * `not`, where a deferred post-filter descriptor could not be applied by the
 * caller without changing the query's meaning.
 */
function compileNode(
  node: Where,
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions,
  conjunctive: boolean,
): CompiledFragment {
  const object = node as Record<string, unknown>;
  const keys = Object.keys(object);

  if (keys.length === 1) {
    const key = keys[0];
    const value = object[key!];
    if (key === "and" && Array.isArray(value)) {
      return compileBoolList(
        value as Where[],
        "AND",
        schema,
        provider,
        options,
        conjunctive,
      );
    }
    if (key === "or" && Array.isArray(value)) {
      return compileBoolList(
        value as Where[],
        "OR",
        schema,
        provider,
        options,
        false,
      );
    }
    if (key === "not" && value !== null && typeof value === "object") {
      const inner = compileNode(
        value as Where,
        schema,
        provider,
        { ...options, preserveUnknown: true },
        false,
      );
      // Negating an always-true expression must match no rows.
      if (!inner.expression) return { expression: sql`1=0`, postFilters: [] };
      return {
        expression: sql`NOT (${inner.expression})`,
        postFilters: [],
      };
    }
  }

  return compileLeaf(node as WhereLeaf, schema, provider, options, conjunctive);
}

function compileBoolList(
  nodes: Where[],
  operator: "AND" | "OR",
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions,
  conjunctive: boolean,
): CompiledFragment {
  const compiled = nodes.map((node) =>
    compileNode(node, schema, provider, options, conjunctive),
  );
  const postFilters = compiled.flatMap((part) => part.postFilters);

  // An always-true OR branch satisfies the whole disjunction, so applying any
  // other branch in SQL would incorrectly drop candidate rows.
  if (operator === "OR" && compiled.some((part) => !part.expression)) {
    return { expression: undefined, postFilters };
  }

  const parts = compiled.flatMap((part) =>
    part.expression ? [sql`(${part.expression})`] : [],
  );
  return {
    expression: parts.length
      ? sql.join(parts, operator === "AND" ? sql` AND ` : sql` OR `)
      : undefined,
    postFilters,
  };
}

function compileLeaf(
  leaf: WhereLeaf,
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions,
  conjunctive: boolean,
): CompiledFragment {
  const clauses: SqlFragment[] = [];
  const postFilters: QueryPostFilter[] = [];

  for (const [fieldName, condition] of Object.entries(leaf)) {
    validateFieldReference(fieldName, schema, "where", options);

    if (isPlainObject(condition)) {
      for (const [operator, value] of Object.entries(condition)) {
        if (operator === "occurs_between") {
          if (!conjunctive) {
            throw new InvalidQueryError(
              `'occurs_between' is only supported in conjunctive position; ` +
                `'${fieldName}' appears under 'or' or 'not', where the deferred ` +
                `post-filter could not be applied without changing the query`,
            );
          }
          postFilters.push(
            compileOccursBetween(
              fieldName,
              value,
              fieldType(fieldName, schema),
            ),
          );
          continue;
        }
        const compiled = compileFilterOp(
          fieldName,
          operator,
          value,
          schema,
          provider,
          options.preserveUnknown,
        );
        clauses.push(compiled);
      }
    } else {
      const compiled = compileEquality(
        fieldName,
        condition,
        schema,
        provider,
        options.preserveUnknown,
      );
      clauses.push(compiled);
    }
  }

  return {
    expression: clauses.length ? sql.join(clauses, sql` AND `) : undefined,
    postFilters,
  };
}

function compileOccursBetween(
  field: string,
  value: unknown,
  type: string | undefined,
): OccursBetweenPostFilter {
  if (type !== "recurrence") {
    throw new InvalidQueryError(
      `'occurs_between' requires a recurrence schema field; '${field}' is '${type ?? "unknown"}'`,
    );
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new InvalidQueryError(
      "'occurs_between' operator requires a [start, end] string tuple",
    );
  }
  return {
    kind: "occurs_between",
    field,
    start: value[0],
    end: value[1],
  };
}

function compileFilterOp(
  field: string,
  operator: string,
  value: unknown,
  schema: Schema,
  provider: DbProvider,
  preserveUnknown = false,
): SqlFragment {
  const extract = extractField(field, provider);
  const comparison = comparisonExpr(field, schema, provider);

  switch (operator) {
    case "eq":
      return compileEquality(field, value, schema, provider, preserveUnknown);
    case "not": {
      const equal = compileEquality(field, value, schema, provider, true);
      return sql`NOT (${equal})`;
    }
    case "gt":
      return sql`${comparison} > ${value}`;
    case "lt":
      return sql`${comparison} < ${value}`;
    case "gte":
      return sql`${comparison} >= ${value}`;
    case "lte":
      return sql`${comparison} <= ${value}`;
    case "contains": {
      if (typeof value !== "string") {
        throw new InvalidQueryError(
          "'contains' operator requires a string value",
        );
      }
      const escaped = value
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
      return sql`${extract} LIKE ${`%${escaped}%`} ESCAPE '\\'`;
    }
    case "in": {
      if (!Array.isArray(value)) {
        throw new InvalidQueryError(
          `'in' operator requires a list, got ${typeof value}`,
        );
      }
      if (value.length === 0) return sql`1 = 0`;
      return sql`${comparison} IN (${sql.join(value.map((item) => comparisonParam(item, provider)))})`;
    }
    case "is_null":
      return value ? sql`${extract} IS NULL` : sql`${extract} IS NOT NULL`;
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new InvalidQueryError(
          "'between' operator requires a [low, high] tuple",
        );
      }
      return sql`${comparison} BETWEEN ${value[0]} AND ${value[1]}`;
    }
    default:
      throw new InvalidQueryError(`Unknown operator: '${operator}'`);
  }
}

// ---------------------------------------------------------------------------
// ORDER BY
// ---------------------------------------------------------------------------

export function compileOrderBy(
  orderBy: string | null | undefined,
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions = {},
): SqlFragment {
  if (!orderBy) return sql`created_at DESC`;

  const descending = orderBy.startsWith("-");
  const field = descending ? orderBy.slice(1) : orderBy;
  const direction = descending ? sql`DESC` : sql`ASC`;

  // These are native DateTime columns rather than JSON/ISO-string fields.
  if (field === "created_at" || field === "updated_at") {
    return sql`${sql.ref(field)} ${direction}`;
  }
  validateFieldReference(field, schema, "order_by", options);
  // Typed expression so numeric fields sort numerically on Postgres, where
  // `->>` would otherwise sort them as text ("10" before "9").
  return sql`${comparisonExpr(field, schema, provider)} ${direction} NULLS ${descending ? sql`FIRST` : sql`LAST`}`;
}

// ---------------------------------------------------------------------------
// Where composition
// ---------------------------------------------------------------------------

export function andWhere(
  left: Where | null | undefined,
  right: Where | null | undefined,
): Where | undefined {
  if (!left) return right ?? undefined;
  if (!right) return left;
  return { and: [left, right] };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface CompiledAggregate {
  expression: SqlFragment;
  columns: string[];
  postFilters: QueryPostFilter[];
}

export function compileAggregate(
  request: AggregateRequest,
  schema: Schema,
  provider: DbProvider,
  orgId: string,
  collectionId: string,
  options: CompileOptions = {},
): CompiledAggregate {
  const groupBy = request.group_by ?? [];
  const selectParts: SqlFragment[] = [];
  const groupExpressions: SqlFragment[] = [];
  const aliasSources = new Map<string, string | undefined>();
  const columns: string[] = [];

  for (const field of groupBy) {
    validateFieldReference(field, schema, "group_by", options);
    if (aliasSources.has(field)) {
      throw new InvalidQueryError(`Duplicate group_by field '${field}'`);
    }
    // Typed expression so boolean/numeric group columns come back with
    // their schema type on Postgres (and HAVING can compare them against
    // typed parameters) instead of as `->>` text.
    const expression = comparisonExpr(field, schema, provider);
    selectParts.push(sql`${expression} AS ${sql.id(field)}`);
    // Group by the selected position: repeated bound JSON paths otherwise
    // become different PostgreSQL expressions ($1 versus $5).
    groupExpressions.push(sql.lit(groupExpressions.length + 1));
    aliasSources.set(field, field);
    columns.push(field);
  }

  for (const metric of request.metrics) {
    const alias = metricAlias(metric);
    if (!isValidFieldName(alias)) {
      throw new InvalidQueryError(
        `Invalid aggregate alias '${alias}' — must match ^[a-zA-Z][a-zA-Z0-9_]*$`,
      );
    }
    if (aliasSources.has(alias)) {
      throw new InvalidQueryError(
        `Aggregate alias '${alias}' collides with another column — set a unique 'as'`,
      );
    }

    if (metric.op === "count") {
      selectParts.push(sql`COUNT(*) AS ${sql.id(alias)}`);
      aliasSources.set(alias, undefined);
    } else {
      validateFieldReference(metric.field, schema, "metric", options, alias);
      if (!isNumericField(metric.field, schema)) {
        throw new InvalidQueryError(
          `'${metric.op}' requires a numeric schema field; '${metric.field}' is not numeric`,
        );
      }
      const numeric = numericExpr(
        extractField(metric.field, provider),
        provider,
      );
      const functions = {
        sum: sql`SUM`,
        avg: sql`AVG`,
        min: sql`MIN`,
        max: sql`MAX`,
      };
      const fn = functions[metric.op];
      if (!fn)
        throw new InvalidQueryError(
          `Unknown aggregate operator: '${metric.op}'`,
        );
      selectParts.push(sql`${fn}(${numeric}) AS ${sql.id(alias)}`);
      aliasSources.set(alias, metric.field);
    }
    columns.push(alias);
  }

  const where = compileWhere(request.where, schema, provider, options);
  const scoped = applyOrgScope(orgId, collectionId, where.expression);
  const groupClause = groupExpressions.length
    ? sql` GROUP BY ${sql.join(groupExpressions)}`
    : sql``;
  const inner = sql`WITH agg AS (SELECT ${sql.join(selectParts)} FROM records WHERE ${scoped}${groupClause})`;
  let outer = sql`SELECT * FROM agg`;
  if (request.having && Object.keys(request.having).length > 0) {
    const having = compileLeafAgainstAliases(
      request.having,
      aliasSources,
      provider,
      options,
    );
    outer = sql`${outer} WHERE ${having}`;
  }
  if (request.order_by)
    outer = sql`${outer} ${compileAliasOrderBy(request.order_by, aliasSources, options)}`;
  return {
    expression: sql`${inner} ${outer} LIMIT ${clampLimit(request.limit ?? 100)} OFFSET ${clampOffset(request.offset ?? 0)}`,
    columns,
    postFilters: where.postFilters,
  };
}

function metricAlias(metric: AggregateMetric): string {
  if (metric.as) return metric.as;
  return metric.op === "count" ? "count" : `${metric.op}_${metric.field}`;
}

function clampLimit(value: number): number {
  return Math.max(1, Math.min(Math.trunc(value), 1000));
}

function clampOffset(value: number): number {
  return Math.max(0, Math.trunc(value));
}

function compileLeafAgainstAliases(
  leaf: WhereLeaf,
  aliasSources: Map<string, string | undefined>,
  provider: DbProvider,
  options: CompileOptions,
): SqlFragment {
  const clauses: SqlFragment[] = [];

  for (const [name, condition] of Object.entries(leaf)) {
    if (!aliasSources.has(name)) {
      throw new InvalidQueryError(
        `'${name}' is not a defined group_by field or metric alias`,
      );
    }
    if (!isValidFieldName(name)) {
      throw new InvalidQueryError(`Invalid alias name: '${name}'`);
    }
    const sourceField = aliasSources.get(name);
    if (
      sourceField !== undefined &&
      options.isFieldAllowed?.(sourceField, {
        kind: "having",
        reference: name,
      }) === false
    ) {
      throw new InvalidQueryError(
        `Field '${sourceField}' is not allowed in having`,
      );
    }

    const reference = sql.ref(name);
    if (isPlainObject(condition)) {
      for (const [operator, value] of Object.entries(condition)) {
        const compiled = compileAliasOp(reference, operator, value, provider);
        clauses.push(compiled);
      }
    } else {
      clauses.push(sql`${reference} = ${comparisonParam(condition, provider)}`);
    }
  }

  return clauses.length ? sql.join(clauses, sql` AND `) : sql`1=1`;
}

function compileAliasOp(
  reference: SqlFragment,
  operator: string,
  value: unknown,
  provider: DbProvider,
): SqlFragment {
  switch (operator) {
    case "eq":
      return sql`${reference} = ${comparisonParam(value, provider)}`;
    case "not":
      return sql`${reference} != ${comparisonParam(value, provider)}`;
    case "gt":
      return sql`${reference} > ${value}`;
    case "lt":
      return sql`${reference} < ${value}`;
    case "gte":
      return sql`${reference} >= ${value}`;
    case "lte":
      return sql`${reference} <= ${value}`;
    case "in": {
      if (!Array.isArray(value)) {
        throw new InvalidQueryError("'in' operator requires a list");
      }
      if (value.length === 0) return sql`1 = 0`;
      return sql`${reference} IN (${sql.join(value.map((item) => comparisonParam(item, provider)))})`;
    }
    case "is_null":
      return value ? sql`${reference} IS NULL` : sql`${reference} IS NOT NULL`;
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new InvalidQueryError("'between' requires a [low, high] tuple");
      }
      return sql`${reference} BETWEEN ${value[0]} AND ${value[1]}`;
    }
    default:
      throw new InvalidQueryError(`Unknown HAVING operator: '${operator}'`);
  }
}

function compileAliasOrderBy(
  orderBy: string,
  aliasSources: Map<string, string | undefined>,
  options: CompileOptions,
): SqlFragment {
  const descending = orderBy.startsWith("-");
  const alias = descending ? orderBy.slice(1) : orderBy;
  const direction = descending ? sql`DESC` : sql`ASC`;
  if (!aliasSources.has(alias)) {
    throw new InvalidQueryError(
      `order_by '${alias}' is not a group_by field or metric alias`,
    );
  }
  if (!isValidFieldName(alias)) {
    throw new InvalidQueryError(`Invalid order_by alias: '${alias}'`);
  }
  const sourceField = aliasSources.get(alias);
  if (
    sourceField !== undefined &&
    options.isFieldAllowed?.(sourceField, {
      kind: "order_by",
      reference: alias,
    }) === false
  ) {
    throw new InvalidQueryError(
      `Field '${sourceField}' is not allowed in order by`,
    );
  }
  return sql`ORDER BY ${sql.ref(alias)} ${direction} NULLS ${descending ? sql`FIRST` : sql`LAST`}`;
}

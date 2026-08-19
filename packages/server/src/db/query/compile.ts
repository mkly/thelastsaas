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

export type DbProvider = "sqlite" | "postgresql";

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
}

export interface OccursBetweenPostFilter {
  kind: "occurs_between";
  field: string;
  start: string;
  end: string;
}

export type QueryPostFilter = OccursBetweenPostFilter;

export interface CompiledFragment {
  sql: string;
  params: unknown[];
  postFilters: QueryPostFilter[];
}

// ---------------------------------------------------------------------------
// Identifier and field safety
// ---------------------------------------------------------------------------

/** Validate that a field is a safe identifier present in the collection schema. */
export function validateField(fieldName: string, schema: Schema): void {
  if (!isValidFieldName(fieldName)) {
    throw new InvalidQueryError(`Invalid field name: '${fieldName}'`);
  }
  if (!(fieldName in schema)) {
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

/** Extract a JSON field as text. Caller is responsible for casting. */
export function extractField(field: string, provider: DbProvider): string {
  if (provider === "postgresql") return `data->>'${field}'`;
  return `json_extract(data, '$.${field}')`;
}

function numericExpr(extract: string, provider: DbProvider): string {
  if (provider === "postgresql") return `(${extract})::numeric`;
  return `CAST(${extract} AS REAL)`;
}

/** Convert `?` placeholders to `$1, $2, ...` for PostgreSQL. */
export function toPgParams(sql: string): string {
  let index = 0;
  return sql.replaceAll("?", () => `$${++index}`);
}

export function dialectSql(sql: string, provider: DbProvider): string {
  return provider === "postgresql" ? toPgParams(sql) : sql;
}

// ---------------------------------------------------------------------------
// Org scoping
// ---------------------------------------------------------------------------

export function applyOrgScope(
  orgId: string,
  collectionId: string,
  whereFragment: string,
  whereParams: unknown[],
): { sql: string; params: unknown[] } {
  const head = "org_id = ? AND collection_id = ?";
  return {
    sql: whereFragment ? `${head} AND ${whereFragment}` : head,
    params: [orgId, collectionId, ...whereParams],
  };
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
  const effectiveWhere = andWhere(where, options.extraWhere);
  if (
    !effectiveWhere ||
    (isPlainObject(effectiveWhere) && Object.keys(effectiveWhere).length === 0)
  ) {
    return { sql: "", params: [], postFilters: [] };
  }
  return compileNode(effectiveWhere, schema, provider, options);
}

function compileNode(
  node: Where,
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions,
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
      );
    }
    if (key === "or" && Array.isArray(value)) {
      return compileBoolList(value as Where[], "OR", schema, provider, options);
    }
    if (key === "not" && value !== null && typeof value === "object") {
      const inner = compileNode(value as Where, schema, provider, options);
      // Negating a deferred condition cannot safely narrow the SQL candidates.
      if (inner.postFilters.length > 0 || !inner.sql) {
        return { sql: "", params: [], postFilters: inner.postFilters };
      }
      return {
        sql: `NOT (${inner.sql})`,
        params: inner.params,
        postFilters: [],
      };
    }
  }

  return compileLeaf(node as WhereLeaf, schema, provider, options);
}

function compileBoolList(
  nodes: Where[],
  operator: "AND" | "OR",
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions,
): CompiledFragment {
  const compiled = nodes.map((node) =>
    compileNode(node, schema, provider, options),
  );
  const postFilters = compiled.flatMap((part) => part.postFilters);

  // An empty OR branch may be satisfied entirely by a deferred post-filter,
  // so applying any other OR branch in SQL would incorrectly drop candidates.
  if (operator === "OR" && compiled.some((part) => !part.sql)) {
    return { sql: "", params: [], postFilters };
  }

  const sqlParts: string[] = [];
  const params: unknown[] = [];
  for (const part of compiled) {
    if (!part.sql) continue;
    sqlParts.push(`(${part.sql})`);
    params.push(...part.params);
  }

  return {
    sql:
      sqlParts.length <= 1
        ? (sqlParts[0] ?? "")
        : sqlParts.join(` ${operator} `),
    params,
    postFilters,
  };
}

function compileLeaf(
  leaf: WhereLeaf,
  schema: Schema,
  provider: DbProvider,
  options: CompileOptions,
): CompiledFragment {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const postFilters: QueryPostFilter[] = [];

  for (const [fieldName, condition] of Object.entries(leaf)) {
    validateFieldReference(fieldName, schema, "where", options);

    if (isPlainObject(condition)) {
      for (const [operator, value] of Object.entries(condition)) {
        if (operator === "occurs_between") {
          postFilters.push(
            compileOccursBetween(
              fieldName,
              value,
              fieldType(fieldName, schema),
            ),
          );
          continue;
        }
        const compiled = compileFilterOp(fieldName, operator, value, provider);
        clauses.push(compiled.sql);
        params.push(...compiled.params);
      }
    } else {
      clauses.push(`${extractField(fieldName, provider)} = ?`);
      params.push(condition);
    }
  }

  return { sql: clauses.join(" AND "), params, postFilters };
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
  provider: DbProvider,
): Omit<CompiledFragment, "postFilters"> {
  const extract = extractField(field, provider);
  const numeric = numericExpr(extract, provider);

  switch (operator) {
    case "eq":
      return { sql: `${extract} = ?`, params: [value] };
    case "not":
      return { sql: `${extract} != ?`, params: [value] };
    case "gt":
      return { sql: `${numeric} > ?`, params: [value] };
    case "lt":
      return { sql: `${numeric} < ?`, params: [value] };
    case "gte":
      return { sql: `${numeric} >= ?`, params: [value] };
    case "lte":
      return { sql: `${numeric} <= ?`, params: [value] };
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
      return {
        sql: `${extract} LIKE ? ESCAPE '\\'`,
        params: [`%${escaped}%`],
      };
    }
    case "in": {
      if (!Array.isArray(value)) {
        throw new InvalidQueryError(
          `'in' operator requires a list, got ${typeof value}`,
        );
      }
      if (value.length === 0) return { sql: "1 = 0", params: [] };
      return {
        sql: `${extract} IN (${value.map(() => "?").join(", ")})`,
        params: value,
      };
    }
    case "is_null":
      return value
        ? { sql: `${extract} IS NULL`, params: [] }
        : { sql: `${extract} IS NOT NULL`, params: [] };
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new InvalidQueryError(
          "'between' operator requires a [low, high] tuple",
        );
      }
      return {
        sql: `${numeric} BETWEEN ? AND ?`,
        params: [value[0], value[1]],
      };
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
): string {
  if (!orderBy) return "ORDER BY created_at DESC";

  const descending = orderBy.startsWith("-");
  const field = descending ? orderBy.slice(1) : orderBy;
  const direction = descending ? "DESC" : "ASC";

  // These are native DateTime columns rather than JSON/ISO-string fields.
  if (field === "created_at" || field === "updated_at") {
    return `ORDER BY ${field} ${direction}`;
  }
  validateFieldReference(field, schema, "order_by", options);
  return `ORDER BY ${extractField(field, provider)} ${direction}`;
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
  sql: string;
  params: unknown[];
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
  const selectParts: string[] = [];
  const groupExpressions: string[] = [];
  const aliasSources = new Map<string, string | undefined>();
  const columns: string[] = [];

  for (const field of groupBy) {
    validateFieldReference(field, schema, "group_by", options);
    if (aliasSources.has(field)) {
      throw new InvalidQueryError(`Duplicate group_by field '${field}'`);
    }
    const expression = extractField(field, provider);
    selectParts.push(`${expression} AS "${field}"`);
    groupExpressions.push(expression);
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
      selectParts.push(`COUNT(*) AS "${alias}"`);
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
      selectParts.push(`${metric.op.toUpperCase()}(${numeric}) AS "${alias}"`);
      aliasSources.set(alias, metric.field);
    }
    columns.push(alias);
  }

  const where = compileWhere(request.where, schema, provider, options);
  const scoped = applyOrgScope(orgId, collectionId, where.sql, where.params);
  const groupClause = groupExpressions.length
    ? ` GROUP BY ${groupExpressions.join(", ")}`
    : "";
  const inner =
    `WITH agg AS (` +
    `SELECT ${selectParts.join(", ")} FROM records WHERE ${scoped.sql}${groupClause}` +
    `)`;

  let outer = "SELECT * FROM agg";
  const outerParams: unknown[] = [];
  if (request.having && Object.keys(request.having).length > 0) {
    const having = compileLeafAgainstAliases(
      request.having,
      aliasSources,
      options,
    );
    if (having.sql) {
      outer += ` WHERE ${having.sql}`;
      outerParams.push(...having.params);
    }
  }
  if (request.order_by) {
    outer += ` ${compileAliasOrderBy(request.order_by, aliasSources, options)}`;
  }

  outer += " LIMIT ? OFFSET ?";
  outerParams.push(
    clampLimit(request.limit ?? 100),
    clampOffset(request.offset ?? 0),
  );

  return {
    sql: `${inner} ${outer}`,
    params: [...scoped.params, ...outerParams],
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
  options: CompileOptions,
): Omit<CompiledFragment, "postFilters"> {
  const clauses: string[] = [];
  const params: unknown[] = [];

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

    const reference = `"${name}"`;
    if (isPlainObject(condition)) {
      for (const [operator, value] of Object.entries(condition)) {
        const compiled = compileAliasOp(reference, operator, value);
        clauses.push(compiled.sql);
        params.push(...compiled.params);
      }
    } else {
      clauses.push(`${reference} = ?`);
      params.push(condition);
    }
  }

  return { sql: clauses.join(" AND "), params };
}

function compileAliasOp(
  reference: string,
  operator: string,
  value: unknown,
): Omit<CompiledFragment, "postFilters"> {
  switch (operator) {
    case "eq":
      return { sql: `${reference} = ?`, params: [value] };
    case "not":
      return { sql: `${reference} != ?`, params: [value] };
    case "gt":
      return { sql: `${reference} > ?`, params: [value] };
    case "lt":
      return { sql: `${reference} < ?`, params: [value] };
    case "gte":
      return { sql: `${reference} >= ?`, params: [value] };
    case "lte":
      return { sql: `${reference} <= ?`, params: [value] };
    case "in": {
      if (!Array.isArray(value)) {
        throw new InvalidQueryError("'in' operator requires a list");
      }
      if (value.length === 0) return { sql: "1 = 0", params: [] };
      return {
        sql: `${reference} IN (${value.map(() => "?").join(", ")})`,
        params: value,
      };
    }
    case "is_null":
      return value
        ? { sql: `${reference} IS NULL`, params: [] }
        : { sql: `${reference} IS NOT NULL`, params: [] };
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new InvalidQueryError("'between' requires a [low, high] tuple");
      }
      return {
        sql: `${reference} BETWEEN ? AND ?`,
        params: [value[0], value[1]],
      };
    }
    default:
      throw new InvalidQueryError(`Unknown HAVING operator: '${operator}'`);
  }
}

function compileAliasOrderBy(
  orderBy: string,
  aliasSources: Map<string, string | undefined>,
  options: CompileOptions,
): string {
  const descending = orderBy.startsWith("-");
  const alias = descending ? orderBy.slice(1) : orderBy;
  const direction = descending ? "DESC" : "ASC";
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
  return `ORDER BY "${alias}" ${direction}`;
}

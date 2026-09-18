import type { QueryAdapter } from "./types";

/** Statements built by the shared compiler use ? exclusively as bind markers. */
export function postgresParameters(statement: string): string {
  let index = 0;
  return statement.replaceAll("?", () => `$${++index}`);
}

/** PostgreSQL queries target JSONB directly, including the data GIN index. */
export const postgresAdapter: QueryAdapter = {
  extract: (field) => `data->>'${field}'`,
  numeric: (expression) => `(${expression})::numeric`,
  boolean: (expression) => `(${expression})::boolean`,
  parameter: (value) => value,
  equality(field, value, preserveUnknown) {
    const contains = "data @> CAST(? AS jsonb)";
    return {
      // SQL comparisons with missing/null values are UNKNOWN. Preserve that
      // under NOT, otherwise negation could accidentally grant access to rows.
      // Positive predicates use bare containment so GIN can locate candidates.
      sql: preserveUnknown
        ? `CASE WHEN ${this.extract(field)} IS NULL THEN NULL ELSE ${contains} END`
        : contains,
      params: [JSON.stringify({ [field]: value })],
    };
  },
  fieldExists: (field) => `data->'${field}' IS NOT NULL`,
  sql: postgresParameters,
  candidateJson: "CAST(? AS jsonb)",
  candidateTimestamp: "CAST(? AS timestamp)",
  timestampParameter: (value) => value.toISOString(),
};

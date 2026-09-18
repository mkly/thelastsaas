import { sql } from "../kysely";
import type { QueryAdapter } from "./types";

/** PostgreSQL queries target JSONB directly, including the data GIN index. */
export const postgresAdapter: QueryAdapter = {
  extract: (field) => sql`data->>${field}`,
  numeric: (expression) => sql`(${expression})::numeric`,
  boolean: (expression) => sql`(${expression})::boolean`,
  parameter: (value) => value,
  equality(field, value, preserveUnknown) {
    const contains = sql`data @> CAST(${JSON.stringify({ [field]: value })} AS jsonb)`;
    // Preserve SQL UNKNOWN under NOT so missing/null fields cannot grant access.
    return preserveUnknown
      ? sql`CASE WHEN ${this.extract(field)} IS NULL THEN NULL ELSE ${contains} END`
      : contains;
  },
  contains(expression, value) {
    const escaped = value
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    return sql`${expression} LIKE ${`%${escaped}%`} ESCAPE '\\'`;
  },
  fieldExists: (field) => sql`data->${field} IS NOT NULL`,
  candidateJson: (value) => sql`CAST(${JSON.stringify(value)} AS jsonb)`,
  candidateTimestamp: (value) => sql`CAST(${value.toISOString()} AS timestamp)`,
};

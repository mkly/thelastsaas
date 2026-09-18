import { sql } from "../kysely";
import type { QueryAdapter } from "./types";

/** SQLite is a standalone deployment backend; JSON operations use JSON1. */
export const sqliteAdapter: QueryAdapter = {
  extract: (field) => sql`json_extract(data, ${`$.${field}`})`,
  numeric: (expression) => sql`CAST(${expression} AS REAL)`,
  boolean: (expression) => expression,
  parameter: (value) => (typeof value === "boolean" ? (value ? 1 : 0) : value),
  equality(field, value) {
    return sql`${this.extract(field)} = ${this.parameter(value)}`;
  },
  contains(expression, value, fieldType) {
    // PostgreSQL ->> renders JSON booleans as text; SQLite extracts 1/0.
    const text =
      fieldType === "boolean"
        ? sql`CASE WHEN ${expression} IS NULL THEN NULL WHEN ${expression} THEN 'true' ELSE 'false' END`
        : expression;
    // instr is a case-sensitive literal substring search and retains SQL NULL.
    // SQLite LIKE folds ASCII case, unlike PostgreSQL's native LIKE.
    return sql`instr(${text}, ${value}) > 0`;
  },
  fieldExists: (field) => sql`json_type(data, ${`$.${field}`}) IS NOT NULL`,
  candidateJson: (value) => sql`${JSON.stringify(value)}`,
  candidateTimestamp: (value) => sql`${value.getTime()}`,
};

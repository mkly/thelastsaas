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
  fieldExists: (field) => sql`json_type(data, ${`$.${field}`}) IS NOT NULL`,
  candidateJson: (value) => sql`${JSON.stringify(value)}`,
  candidateTimestamp: (value) => sql`${value.getTime()}`,
};

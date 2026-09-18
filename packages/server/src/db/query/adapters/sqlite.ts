import type { QueryAdapter } from "./types";

/** SQLite is a standalone deployment backend; JSON operations use JSON1. */
export const sqliteAdapter: QueryAdapter = {
  extract: (field) => `json_extract(data, '$.${field}')`,
  numeric: (expression) => `CAST(${expression} AS REAL)`,
  boolean: (expression) => expression,
  parameter: (value) => (typeof value === "boolean" ? (value ? 1 : 0) : value),
  equality(field, value) {
    return {
      sql: `${this.extract(field)} = ?`,
      params: [this.parameter(value)],
    };
  },
  fieldExists: (field) => `json_type(data, '$.${field}') IS NOT NULL`,
  sql: (statement) => statement,
  candidateJson: "?",
  candidateTimestamp: "?",
  timestampParameter: (value) => value.getTime(),
};

import type { SqlFragment } from "../kysely";
export type DbProvider = "sqlite" | "postgresql";
export type { SqlFragment };

/** Fields and types have already been checked against the collection schema. */
export interface QueryAdapter {
  extract(field: string): SqlFragment;
  numeric(expression: SqlFragment): SqlFragment;
  boolean(expression: SqlFragment): SqlFragment;
  parameter(value: unknown): unknown;
  equality(
    field: string,
    value: string | number | boolean,
    preserveUnknown: boolean,
  ): SqlFragment;
  contains(
    expression: SqlFragment,
    value: string,
    fieldType?: string,
  ): SqlFragment;
  fieldExists(field: string): SqlFragment;
  candidateJson(value: unknown): SqlFragment;
  candidateTimestamp(value: Date): SqlFragment;
}

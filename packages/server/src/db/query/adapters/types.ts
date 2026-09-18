export type DbProvider = "sqlite" | "postgresql";

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/** Fields and types have already been checked against the collection schema. */
export interface QueryAdapter {
  extract(field: string): string;
  numeric(expression: string): string;
  boolean(expression: string): string;
  parameter(value: unknown): unknown;
  equality(
    field: string,
    value: string | number | boolean,
    preserveUnknown: boolean,
  ): SqlFragment;
  fieldExists(field: string): string;
  sql(statement: string): string;
  candidateJson: string;
  candidateTimestamp: string;
  timestampParameter(value: Date): number | string;
}

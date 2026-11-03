export interface FieldAccess {
  readableFields: ReadonlySet<string>;
  writableFields: ReadonlySet<string>;
}

export function filterReadableData(
  data: Record<string, unknown>,
  filter?: FieldAccess | null,
): Record<string, unknown> {
  if (!filter) return data;
  return Object.fromEntries(
    Object.entries(data).filter(([field]) => filter.readableFields.has(field)),
  );
}

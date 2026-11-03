import { z } from "zod";
import { validateRecurrence } from "./recurrence";
import { SchemaValidationError } from "./errors";

import type { FieldDef, Schema } from "./types";

export const FIELD_TYPES = [
  "string",
  "text",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "datetime",
  "json",
  "recurrence",
  "attachments",
] as const;

const VALID_FIELD_TYPES = new Set<string>(FIELD_TYPES);
const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
export const recurrenceValueSchema = z.string().refine((value) => {
  try {
    validateRecurrence(value);
    return true;
  } catch {
    return false;
  }
});

const validationOptions = {
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  pattern: z.string().optional(),
};

const fieldUpdateSchema = z
  .object({
    ...validationOptions,
    type: z.string().optional(),
    description: z.string().optional(),
    multiple: z.boolean().optional(),
  })
  .strict();

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidFieldName(name: string): boolean {
  return FIELD_NAME_RE.test(name);
}

export function validateFieldType(fieldType: string): boolean {
  if (VALID_FIELD_TYPES.has(fieldType)) return true;
  if (fieldType.startsWith("enum:")) {
    const values = fieldType.slice(5);
    return (
      values.length > 0 && values.split(",").every((value) => value.trim())
    );
  }
  if (fieldType.startsWith("ref:")) {
    return fieldType.slice(4).trim().length > 0;
  }
  return false;
}

export function extractFieldType(fieldDef: FieldDef): string | null {
  if (typeof fieldDef === "string") return fieldDef;
  if (isPlainObject(fieldDef) && typeof fieldDef.type === "string") {
    return fieldDef.type;
  }
  return null;
}

export function validateSchema(schema: Schema): string[] {
  const errors: string[] = [];
  const entries = Object.entries(schema);
  if (entries.length === 0) return ["Schema must have at least one field"];

  for (const [fieldName, fieldDef] of entries) {
    if (
      isPlainObject(fieldDef) &&
      fieldDef.multiple !== undefined &&
      (typeof fieldDef.multiple !== "boolean" ||
        !extractFieldType(fieldDef)?.startsWith("ref:"))
    ) {
      errors.push(
        `Field '${fieldName}': multiple is only valid for reference fields`,
      );
    }
    if (isPlainObject(fieldDef)) {
      const parsed = fieldUpdateSchema.safeParse(fieldDef);
      if (!parsed.success)
        errors.push(`Field '${fieldName}': invalid field options`);
      const type = extractFieldType(fieldDef);
      const bounded = ["string", "text", "number", "integer", "float"].includes(
        type ?? "",
      );
      if (
        (fieldDef.min !== undefined || fieldDef.max !== undefined) &&
        !bounded
      )
        errors.push(
          `Field '${fieldName}': min and max require a string or numeric type`,
        );
      if (["string", "text"].includes(type ?? "")) {
        for (const bound of [fieldDef.min, fieldDef.max])
          if (
            bound !== undefined &&
            (!Number.isInteger(bound) || Number(bound) < 0)
          )
            errors.push(
              `Field '${fieldName}': length bounds must be nonnegative integers`,
            );
      }
      if (
        typeof fieldDef.min === "number" &&
        typeof fieldDef.max === "number" &&
        fieldDef.min > fieldDef.max
      )
        errors.push(`Field '${fieldName}': min cannot exceed max`);
      if (fieldDef.pattern !== undefined) {
        if (!["string", "text"].includes(type ?? ""))
          errors.push(`Field '${fieldName}': pattern requires a string type`);
        try {
          new RegExp(String(fieldDef.pattern));
        } catch {
          errors.push(`Field '${fieldName}': invalid pattern`);
        }
      }
    }
    if (!isValidFieldName(fieldName)) {
      errors.push(
        `Field name '${fieldName}' must start with a letter and contain only letters, digits, and underscores`,
      );
      continue;
    }
    const fieldType = extractFieldType(fieldDef);
    if (fieldType === null) {
      errors.push(
        `Field '${fieldName}': must be a type string or an object with a 'type' key`,
      );
    } else if (!validateFieldType(fieldType)) {
      errors.push(`Field '${fieldName}': unknown type '${fieldType}'`);
    }
    if (
      isPlainObject(fieldDef) &&
      fieldDef.description !== undefined &&
      typeof fieldDef.description !== "string"
    ) {
      errors.push(`Field '${fieldName}': description must be a string`);
    }
  }
  return errors;
}

export function validateFieldUpdates(
  updateFields: Record<string, unknown>,
  schema: Schema,
): string[] {
  const errors: string[] = [];
  for (const [fieldName, updateDef] of Object.entries(updateFields)) {
    if (!(fieldName in schema)) {
      errors.push(
        `Field '${fieldName}' does not exist in the schema (use add_fields to add new fields)`,
      );
      continue;
    }
    if (!isPlainObject(updateDef)) {
      errors.push(`Field '${fieldName}': update must be an object`);
      continue;
    }
    const parsed = fieldUpdateSchema.safeParse(updateDef);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(
          `Field '${fieldName}': ${String(issue.path[0])} must be a string`,
        );
      }
    } else if (
      parsed.data.type !== undefined &&
      !validateFieldType(parsed.data.type)
    ) {
      errors.push(`Field '${fieldName}': unknown type '${parsed.data.type}'`);
    } else if (
      (parsed.data.type !== undefined &&
        parsed.data.type !== extractFieldType(schema[fieldName]!) &&
        !isEnumExtension(
          extractFieldType(schema[fieldName]!)!,
          parsed.data.type,
        )) ||
      (parsed.data.multiple !== undefined &&
        parsed.data.multiple !== isMultipleReference(schema[fieldName]!))
    ) {
      errors.push(
        `Field '${fieldName}': changing an existing field type is unsupported`,
      );
    }
  }
  if (!errors.length) {
    for (const [name, update] of Object.entries(updateFields))
      errors.push(
        ...validateSchema({
          [name]: applyFieldUpdate(
            schema[name]!,
            update as Record<string, unknown>,
          ),
        }),
      );
  }
  return errors;
}

function isEnumExtension(before: string, after: string): boolean {
  if (!before.startsWith("enum:") || !after.startsWith("enum:")) return false;
  const values = new Set(
    after
      .slice(5)
      .split(",")
      .map((value) => value.trim()),
  );
  return before
    .slice(5)
    .split(",")
    .every((value) => values.has(value.trim()));
}

export function applyFieldUpdate(
  existingDef: FieldDef,
  updateDef: Record<string, unknown>,
): FieldDef {
  return {
    ...(typeof existingDef === "string" ? { type: existingDef } : existingDef),
    ...fieldUpdateSchema.parse(updateDef),
  };
}

/** Compile a strict schema once for all records in an operation. */
export function compileRecordSchema(schema: Schema) {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, definition] of Object.entries(schema)) {
    const options =
      typeof definition === "string" ? { type: definition } : definition;
    const type = options.type;
    let value: z.ZodType;
    if (type === "attachments" || isMultipleReference(definition)) {
      value = z
        .array(z.string().min(1))
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length);
    } else if (["string", "text"].includes(type)) {
      let text = z.string();
      if (options.min !== undefined) text = text.min(options.min);
      if (options.max !== undefined) text = text.max(options.max);
      if (options.pattern !== undefined)
        text = text.regex(new RegExp(options.pattern));
      value = text;
    } else if (["number", "float", "integer"].includes(type)) {
      let number = type === "integer" ? z.number().int() : z.number();
      if (options.min !== undefined) number = number.min(options.min);
      if (options.max !== undefined) number = number.max(options.max);
      value = number;
    } else if (type === "date") {
      value = z.iso.date().transform((value) => value);
    } else if (type === "datetime") {
      value = z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value).toISOString());
    } else if (type === "boolean") value = z.boolean();
    else if (type === "json") value = z.json();
    else if (type === "recurrence") value = recurrenceValueSchema;
    else if (type.startsWith("enum:"))
      value = z.enum(
        type
          .slice(5)
          .split(",")
          .map((value) => value.trim()),
      );
    else if (type.startsWith("ref:")) value = z.string().min(1);
    else value = z.never();
    shape[name] = options.required
      ? value.refine((value) => value !== null)
      : value.nullable().optional();
  }
  return z.object(shape).strict();
}

export function validateRecordData(
  data: Record<string, unknown>,
  schema: Schema,
): string[] {
  const result = compileRecordSchema(schema).safeParse(data);
  return result.success
    ? []
    : result.error.issues.map(
        (issue) => `${issue.path.join(".") || "record"}: ${issue.code}`,
      );
}

export function parseRecordData(
  data: Record<string, unknown>,
  compiled: ReturnType<typeof compileRecordSchema>,
): Record<string, unknown> {
  const result = compiled.safeParse(data);
  if (!result.success)
    throw new SchemaValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "record"}: ${issue.code}`,
      ),
      result.error.issues.map((issue) => ({
        path: issue.path.map(String),
        code: issue.code,
      })),
    );
  return result.data;
}

export function sanitizePathComponent(name: string): string {
  let safe = name.replaceAll(/[/\\]/g, "_").replaceAll("\0", "");
  safe = safe.replaceAll("..", "_").replace(/^[.\s]+|[.\s]+$/g, "");
  return safe || "unnamed";
}

export function isSafePathComponent(name: string): boolean {
  return name.length > 0 && sanitizePathComponent(name) === name;
}

export function genId(): string {
  return Bun.randomUUIDv7();
}

export function isMultipleReference(definition: FieldDef): boolean {
  return isPlainObject(definition) && definition.multiple === true;
}

export const fieldDefinitionSchema = z.union([
  z.string(),
  z
    .object({
      ...validationOptions,
      type: z.string(),
      description: z.string().optional(),
      multiple: z.boolean().optional(),
    })
    .strict(),
]);
export const attachmentDestinationSchema = z
  .object({
    collection: z.string().min(1),
    record_id: z.string().min(1),
    field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  })
  .strict();
export type AttachmentDestination = z.infer<typeof attachmentDestinationSchema>;
export const expandSchema = z
  .array(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){0,3}$/),
  )
  .max(20);

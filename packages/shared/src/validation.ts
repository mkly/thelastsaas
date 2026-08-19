import { z } from "zod";

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
] as const;

const VALID_FIELD_TYPES = new Set<string>(FIELD_TYPES);
const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const DATE_TIME_VALUE = String.raw`\d{8}T\d{6}`;
const DTSTART_RE = new RegExp(
  String.raw`^DTSTART;TZID=[^:;\r\n]+:${DATE_TIME_VALUE}$`,
);
const RRULE_RE =
  /^RRULE:FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;[A-Z][A-Z0-9-]*=[^:;\r\n]+)*$/;
const EXDATE_RE = new RegExp(
  String.raw`^EXDATE(?:;TZID=[^:;\r\n]+)?:${DATE_TIME_VALUE}(?:,${DATE_TIME_VALUE})*$`,
);

export const recurrenceValueSchema = z.string().refine(
  (value) => {
    const lines = value.replaceAll("\r\n", "\n").split("\n");
    return (
      (lines.length === 2 || lines.length === 3) &&
      DTSTART_RE.test(lines[0] ?? "") &&
      RRULE_RE.test(lines[1] ?? "") &&
      (lines.length === 2 || EXDATE_RE.test(lines[2] ?? ""))
    );
  },
  {
    message:
      "recurrence must contain DTSTART;TZID, RRULE, and optionally EXDATE",
  },
);

const fieldUpdateSchema = z.object({
  type: z.string().optional(),
  description: z.string().optional(),
});

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
    }
  }
  return errors;
}

export function applyFieldUpdate(
  existingDef: FieldDef,
  updateDef: Record<string, unknown>,
): { type: string; description?: string } {
  const result: { type: string; description?: string } = {
    type:
      (typeof updateDef.type === "string"
        ? updateDef.type
        : extractFieldType(existingDef)) ?? "string",
  };
  if (
    isPlainObject(existingDef) &&
    existingDef.description !== undefined &&
    !("description" in updateDef)
  ) {
    result.description = existingDef.description;
  }
  if (typeof updateDef.description === "string") {
    result.description = updateDef.description;
  }
  return result;
}

export function validateRecordData(
  data: Record<string, unknown>,
  schema: Schema,
): string[] {
  const errors: string[] = [];
  for (const [fieldName, value] of Object.entries(data)) {
    if (fieldName.startsWith("_")) continue;
    if (!(fieldName in schema)) {
      errors.push(`Unknown field '${fieldName}' (not in schema)`);
      continue;
    }
    if (value === null || value === undefined) continue;
    const fieldType = extractFieldType(schema[fieldName]!);
    if (fieldType === null) {
      errors.push(`Field '${fieldName}': schema has invalid type definition`);
      continue;
    }
    const error = validateValue(fieldName, value, fieldType);
    if (error) errors.push(error);
  }
  return errors;
}

function validateValue(
  fieldName: string,
  value: unknown,
  fieldType: string,
): string | null {
  const schema = buildValueSchema(fieldType);
  if (!schema || schema.safeParse(value).success) return null;
  if (fieldType === "recurrence") {
    return `Field '${fieldName}': invalid recurrence value`;
  }
  if (fieldType.startsWith("enum:")) {
    const allowed = fieldType
      .slice(5)
      .split(",")
      .map((item) => item.trim());
    return `Field '${fieldName}': value '${value}' not in allowed values: ${JSON.stringify(allowed)}`;
  }
  if (fieldType.startsWith("ref:")) {
    return `Field '${fieldName}': ref must be a string (record ID), got ${typeof value}`;
  }
  return `Field '${fieldName}': expected ${fieldType}, got ${typeof value}`;
}

function buildValueSchema(fieldType: string): z.ZodType<unknown> | null {
  if (["string", "text", "date", "datetime"].includes(fieldType)) {
    return z.string();
  }
  if (["number", "float"].includes(fieldType)) return z.number();
  if (fieldType === "integer") return z.number().int();
  if (fieldType === "boolean") return z.boolean();
  if (fieldType === "json") return z.unknown();
  if (fieldType === "recurrence") return recurrenceValueSchema;
  if (fieldType.startsWith("enum:")) {
    const allowed = fieldType
      .slice(5)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return allowed.length ? z.enum([allowed[0]!, ...allowed.slice(1)]) : null;
  }
  if (fieldType.startsWith("ref:")) return z.string();
  return null;
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

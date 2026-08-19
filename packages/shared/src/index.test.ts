import { describe, expect, test } from "bun:test";

import {
  API_VERSION,
  CollectionNotFoundError,
  SchemaValidationError,
  errorResponse,
  isPlainObject,
  isValidFieldName,
  recurrenceValueSchema,
  sanitizePathComponent,
  validateFieldType,
  validateFieldUpdates,
  validateRecordData,
  validateSchema,
} from "./index";

describe("shared package", () => {
  test("exports the API version", () => {
    expect(API_VERSION).toBe("v1");
  });
});

describe("schema validation", () => {
  test("validates names and object shapes", () => {
    expect(isValidFieldName("field_name1")).toBe(true);
    expect(isValidFieldName("1field")).toBe(false);
    expect(isPlainObject({ value: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
  });

  test("accepts recurrence, enum, and reference fields", () => {
    expect(validateFieldType("recurrence")).toBe(true);
    expect(
      validateSchema({
        schedule: "recurrence",
        status: "enum:active,inactive",
        owner: "ref:users",
      }),
    ).toEqual([]);
  });

  test("rejects empty schemas, invalid fields, and bad updates", () => {
    expect(validateSchema({})).toEqual(["Schema must have at least one field"]);
    expect(validateSchema({ "1bad": "string" })).toHaveLength(1);
    expect(
      validateFieldUpdates({ name: { type: 42 } }, { name: "string" }),
    ).toEqual(["Field 'name': type must be a string"]);
  });
});

describe("recurrence values", () => {
  const valid =
    "DTSTART;TZID=America/Los_Angeles:20260818T090000\n" +
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE\n" +
    "EXDATE;TZID=America/Los_Angeles:20260824T090000,20260826T090000";

  test("accepts DTSTART;TZID, RRULE, and optional EXDATE", () => {
    expect(recurrenceValueSchema.safeParse(valid).success).toBe(true);
    expect(
      recurrenceValueSchema.safeParse(
        valid.split("\n").slice(0, 2).join("\r\n"),
      ).success,
    ).toBe(true);
    expect(
      validateRecordData({ schedule: valid }, { schedule: "recurrence" }),
    ).toEqual([]);
  });

  test("rejects structurally invalid recurrence values", () => {
    expect(recurrenceValueSchema.safeParse("RRULE:FREQ=WEEKLY").success).toBe(
      false,
    );
    expect(
      validateRecordData(
        { schedule: "DTSTART:20260818T090000\nRRULE:FREQ=WEEKLY" },
        { schedule: "recurrence" },
      ),
    ).toEqual(["Field 'schedule': invalid recurrence value"]);
  });
});

describe("record and utility validation", () => {
  test("validates record values", () => {
    const schema = { name: "string", age: "integer", active: "boolean" };
    expect(validateRecordData({ name: "Ada", age: 37 }, schema)).toEqual([]);
    expect(validateRecordData({ age: 3.5 }, schema)).toEqual([
      "Field 'age': expected integer, got number",
    ]);
    expect(validateRecordData({ unknown: true }, schema)).toEqual([
      "Unknown field 'unknown' (not in schema)",
    ]);
  });

  test("sanitizes unsafe path components", () => {
    expect(sanitizePathComponent("../etc/passwd")).toBe("__etc_passwd");
    expect(sanitizePathComponent("   ")).toBe("unnamed");
  });
});

describe("error hierarchy", () => {
  test("preserves response and validation error shapes", () => {
    const notFound = new CollectionNotFoundError("people");
    expect(notFound.toResponse()).toEqual({
      status: "error",
      error: "CollectionNotFoundError",
      message: "Collection 'people' not found",
    });
    const validation = new SchemaValidationError(["bad field"]);
    expect(validation.errors).toEqual(["bad field"]);
    expect(errorResponse("Bad", "bad request")).toEqual({
      status: "error",
      error: "Bad",
      message: "bad request",
    });
  });
});

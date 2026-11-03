import { describe, expect, test } from "bun:test";
import {
  applyFieldUpdate,
  validateFieldUpdates,
  validateRecordData,
  validateSchema,
} from "./validation";

describe("field validation options", () => {
  test("requires fields and enforces numeric bounds and string format", () => {
    const schema = {
      discount: { type: "number", min: 0, max: 100 },
      customer: { type: "ref:customers", required: true },
      email: { type: "string", min: 3, max: 80, pattern: "^[^@]+@[^@]+$" },
    };
    expect(
      validateRecordData(
        { discount: 10, customer: "c1", email: "a@b" },
        schema,
      ),
    ).toEqual([]);
    expect(
      validateRecordData({ discount: -1, customer: null, email: "x" }, schema),
    ).toHaveLength(4);
    expect(validateRecordData({}, schema)).toHaveLength(1);
    expect(
      validateRecordData({ customer: "c1", _id: "hidden" }, schema),
    ).toHaveLength(1);
  });

  test("validates option applicability and bounds at schema definition time", () => {
    for (const definition of [
      { type: "boolean", min: 1 },
      { type: "number", pattern: "x" },
      { type: "string", pattern: "[" },
      { type: "string", min: -1 },
      { type: "string", min: 1.5 },
      { type: "number", min: 5, max: 1 },
      { type: "string", unknown: true },
    ])
      expect(validateSchema({ value: definition }).length).toBeGreaterThan(0);
  });

  test("merges updates without dropping options and permits only additive enums", () => {
    const original = {
      type: "string",
      description: "Email",
      required: true,
      min: 3,
    };
    expect(applyFieldUpdate(original, { max: 80 })).toEqual({
      ...original,
      max: 80,
    });
    expect(
      validateFieldUpdates(
        { status: { type: "enum:draft,pending,approved" } },
        { status: "enum:draft,pending" },
      ),
    ).toEqual([]);
    expect(
      validateFieldUpdates(
        { status: { type: "enum:draft" } },
        { status: "enum:draft,pending" },
      ),
    ).toHaveLength(1);
    expect(
      validateFieldUpdates(
        { value: { max: 1 } },
        { value: { type: "number", min: 5 } },
      ),
    ).toHaveLength(1);
  });
});

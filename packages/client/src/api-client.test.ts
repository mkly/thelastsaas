import { describe, expect, test } from "bun:test";

import { handleResponse, parseJson } from "./api-client";
import { ReauthenticationRequiredError } from "./errors";

describe("API client conventions", () => {
  test("returns successful response envelopes", async () => {
    const result = await handleResponse<{ status: "ok"; value: number }>(
      Response.json({ status: "ok", value: 42 }),
    );
    expect(result.value).toBe(42);
  });

  test("turns HTTP 401 into a clear re-authentication error", async () => {
    const response = Response.json({ status: "error" }, { status: 401 });
    expect(handleResponse(response)).rejects.toBeInstanceOf(
      ReauthenticationRequiredError,
    );
    expect(handleResponse(Response.json({}, { status: 401 }))).rejects.toThrow(
      "saas login",
    );
  });

  test("uses server error-envelope messages", async () => {
    const response = Response.json(
      { status: "error", message: "collection not found" },
      { status: 404 },
    );
    expect(handleResponse(response)).rejects.toThrow("collection not found");
  });

  test("labels invalid JSON arguments", () => {
    expect(() => parseJson("{", "--where")).toThrow(
      "--where must be valid JSON",
    );
  });
});

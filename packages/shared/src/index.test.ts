import { describe, expect, test } from "bun:test";

import { API_VERSION } from "./index";

describe("shared package", () => {
  test("exports the API version", () => {
    expect(API_VERSION).toBe("v1");
  });
});

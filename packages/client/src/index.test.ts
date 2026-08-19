import { describe, expect, test } from "bun:test";

import { apiPath } from "./index";

describe("client package", () => {
  test("builds a versioned API path", () => {
    expect(apiPath("collections")).toBe("/v1/collections");
  });
});

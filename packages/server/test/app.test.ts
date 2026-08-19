import { afterEach, describe, expect, test } from "bun:test";

import { createTestApp } from "./harness";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("server skeleton", () => {
  test("serves the health endpoint without a network listener", async () => {
    const testApp = await createTestApp();
    cleanups.push(testApp.close);

    const response = await testApp.app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("isolates SQLite services between test app instances", async () => {
    const first = await createTestApp();
    const second = await createTestApp();
    cleanups.push(first.close, second.close);

    first.services.database.exec(
      "CREATE TABLE example (id INTEGER PRIMARY KEY)",
    );

    const tableQuery = "SELECT name FROM sqlite_master WHERE name = 'example'";
    expect(first.services.database.query(tableQuery).get()).not.toBeNull();
    expect(second.services.database.query(tableQuery).get()).toBeNull();
  });
});

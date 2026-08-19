import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { loadConfig } from "../src/config";
import { closeServices, createServices } from "../src/services";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("createServices", () => {
  test("uses one database for relative SQLite URLs", async () => {
    const directory = mkdtempSync(join(process.cwd(), ".lastsaas-services-"));
    cleanupPaths.push(directory);
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: `file:./${basename(directory)}/test.sqlite`,
    });

    const services = await createServices(config);
    try {
      expect(services.database).not.toBeNull();
      services.database!.exec(
        "CREATE TABLE path_check (id INTEGER PRIMARY KEY)",
      );
      const rows = await services.prisma.$queryRawUnsafe<unknown[]>(
        "SELECT * FROM path_check",
      );

      expect(rows).toEqual([]);
    } finally {
      await closeServices(services);
    }
  });
});

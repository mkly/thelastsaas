import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeServices, createServices } from "../src/services";
import { testMigrationSql } from "./test-migrations";

test("services finish OAuth resource initialization before returning to callers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-services-lifecycle-"));
  const path = join(directory, "test.sqlite");
  const database = new Database(path);
  database.exec(testMigrationSql);
  database.close();
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: `file:${path}`,
    STORAGE_PATH: join(directory, "files"),
  });
  const services = await createServices(config);
  try {
    // A synchronous read cannot accidentally wait for pending auth work.
    expect(
      services
        .database!.query('SELECT count(*) AS count FROM "oauthResource"')
        .get(),
    ).toEqual({ count: 1 });
  } finally {
    // Drain the old implementation too, so the failing regression test itself
    // does not disconnect Prisma underneath the outstanding resource insert.
    await services.auth.$context;
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  }
});

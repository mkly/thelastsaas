import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Tests create empty databases from the current schema; they never upgrade data.
export const testMigrationSql = execFileSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/prisma/build/index.js", import.meta.url),
    ),
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema-datamodel",
    fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
    "--script",
  ],
  { encoding: "utf8", env: { ...process.env, DATABASE_URL: "file:unused.db" } },
);

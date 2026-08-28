import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const migrationsDirectory = fileURLToPath(
  new URL("../prisma/migrations", import.meta.url),
);

export const testMigrationSql = readdirSync(migrationsDirectory)
  .sort()
  .map((name) => join(migrationsDirectory, name, "migration.sql"))
  .filter((path) => existsSync(path))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

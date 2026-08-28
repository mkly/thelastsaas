import { readFileSync } from "node:fs";

const migrationPaths = [
  "../prisma/migrations/20260819015000_init/migration.sql",
  "../prisma/migrations/20260828190000_add_user_kind/migration.sql",
] as const;

export const testMigrationSql = migrationPaths
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");

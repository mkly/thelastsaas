import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AppConfig } from "./config";

export interface AppServices {
  database: Database;
}

function sqlitePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL must use the file: scheme in SQLite mode");
  }

  const path = databaseUrl.slice("file:".length);
  if (path === ":memory:") return path;
  if (!path) throw new Error("DATABASE_URL must include a SQLite path");
  return resolve(path);
}

export function createServices(config: AppConfig): AppServices {
  const path = sqlitePath(config.databaseUrl);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const database = new Database(path, { create: true });
  database.exec("PRAGMA foreign_keys = ON");
  return { database };
}

export function closeServices(services: AppServices): void {
  services.database.close();
}

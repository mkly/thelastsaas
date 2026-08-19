import { PrismaClient } from "@prisma/client";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AppConfig } from "./config";
import { createStorage, databaseProvider } from "./config";
import { createAuth, type Auth, type AuthEmailSender } from "./auth";
import {
  createNotificationServices,
  type NotificationDispatcher,
  type NotificationQueue,
} from "./notifications";
import {
  createBackgroundScheduler,
  type BackgroundScheduler,
} from "./scheduler";
import type { Storage } from "./storage/interface";

export interface AppServices {
  database: Database | null;
  prisma: PrismaClient;
  auth: Auth;
  notifications: NotificationDispatcher;
  notificationQueue: NotificationQueue;
  scheduler: BackgroundScheduler;
  storage: Storage;
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

export async function createServices(
  config: AppConfig,
  sendAuthEmail?: AuthEmailSender,
): Promise<AppServices> {
  const provider = databaseProvider(config.databaseUrl);
  let database: Database | null = null;
  if (provider === "sqlite") {
    const path = sqlitePath(config.databaseUrl);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    database = new Database(path, { create: true });
    database.exec("PRAGMA foreign_keys = ON");
  }
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const auth = createAuth(prisma, config, sendAuthEmail);
  const notificationServices = createNotificationServices(prisma, config);
  const scheduler = createBackgroundScheduler(
    prisma,
    notificationServices.notificationQueue,
    config,
  );
  const storage = await createStorage(config);
  return {
    database,
    prisma,
    auth,
    scheduler,
    storage,
    ...notificationServices,
  };
}

export async function closeServices(services: AppServices): Promise<void> {
  await services.scheduler.stop();
  services.database?.close();
  await services.prisma.$disconnect();
}

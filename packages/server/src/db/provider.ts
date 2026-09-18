import type { PrismaClient } from "@prisma/client";
import { databaseProvider, type DatabaseProvider } from "../config";

const providers = new WeakMap<PrismaClient, DatabaseProvider>();

export function registerDatabaseProvider(
  prisma: PrismaClient,
  url: string,
): void {
  providers.set(prisma, databaseProvider(url));
}

/** Resolve from the client's configured datasource, never a module-load global. */
export function queryProvider(prisma: PrismaClient): DatabaseProvider {
  const provider = providers.get(prisma);
  if (!provider)
    throw new Error(
      "Database provider has not been registered for this Prisma client",
    );
  return provider;
}

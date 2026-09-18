import type { PrismaClient } from "@prisma/client";
import type { Cache } from "../cache";

// Separate service/database instances never share cached data.
const caches = new WeakMap<PrismaClient, { cache: Cache; ttlMs: number }>();

export function registerMetadataCache(
  prisma: PrismaClient,
  cache: Cache,
  ttlMs: number,
): void {
  caches.set(prisma, { cache, ttlMs });
}

export const collectionCacheKey = (orgId: string, name: string) =>
  JSON.stringify(["collection", orgId, name]);
export const policyCacheKey = (orgId: string) =>
  JSON.stringify(["policies", orgId]);

export function cachedMetadata<T>(
  prisma: PrismaClient,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const registered = caches.get(prisma);
  return registered
    ? registered.cache.remember(key, registered.ttlMs, load)
    : load();
}

export async function invalidateMetadata(
  prisma: PrismaClient,
  ...keys: string[]
): Promise<void> {
  await caches.get(prisma)?.cache.invalidate(...keys);
}

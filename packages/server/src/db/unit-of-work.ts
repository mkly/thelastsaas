import type { Prisma, PrismaClient } from "@prisma/client";
import { genId } from "@lastsaas/shared";
import type { DbProvider } from "./query/adapters/types";

/** Prisma and compiled SQL must use this same transaction and explicit dialect. */
import { jobsFor } from "../jobs";
import type { JobBackend } from "../jobs/types";

export interface UnitOfWork {
  changeSetId?: string;
  readonly jobs?: JobBackend;
  readonly db: Prisma.TransactionClient;
  readonly provider: DbProvider;
}

export type UnitOfWorkSource =
  { readonly prisma: PrismaClient; readonly provider: DbProvider } | UnitOfWork;

/**
 * Outer services pass { prisma, provider } to own one transaction. Nested
 * services pass the existing UnitOfWork to join it, without committing early
 * or looking up a transaction client in the root-client provider cache.
 * Failures propagate to the outer transaction, which rolls back all writes.
 * Options apply only when this call owns the transaction.
 */
export async function withUnitOfWork<T>(
  source: UnitOfWorkSource,
  operation: (context: UnitOfWork) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  if ("db" in source) return operation(source);
  return source.prisma.$transaction(
    (db) =>
      operation({
        changeSetId: genId(),
        db,
        provider: source.provider,
        jobs: jobsFor(source.prisma),
      }),
    options,
  );
}

import { z } from "zod";
import { InvalidQueryError, type Schema } from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import { compileRule } from "./rule-context";
import { getCollectionInTransaction } from "./collections";
export const policyOptionsSchema = {
  cond: z.string().min(1).max(8192).optional(),
  msg: z.string().max(2048).optional(),
};
export interface PolicyOptions {
  cond?: string;
  msg?: string;
}
export async function validatePolicyOptions(
  db: Prisma.TransactionClient,
  orgId: string,
  resource: string,
  _action: string,
  options: PolicyOptions,
) {
  const parsed = compileRule(options.cond ?? "true");
  const match =
    /^\/collections\/([^/*]+)(?:\/fields\/(?:[a-zA-Z][a-zA-Z0-9_]*|\*))?$/.exec(
      resource,
    );
  if (resource.includes("/fields/") && parsed.usesRecord)
    throw new InvalidQueryError("Field access cannot depend on record data");
  if (parsed.references.size) {
    if (!match)
      throw new InvalidQueryError(
        "Related-record conditions require a specific collection",
      );
    const collection = await getCollectionInTransaction(db, orgId, match[1]!);
    compileRule(options.cond!, collection.schema as Schema);
  }
}

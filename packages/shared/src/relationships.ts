import { z } from "zod";
import { whereSchema } from "./where";
import { expandSchema } from "./validation";
export const relatedRecordsSchema = z
  .object({
    source_collection: z.string().min(1),
    field: z.string().min(1),
    where: whereSchema.optional(),
    order_by: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
    expand: expandSchema.optional(),
  })
  .strict();
export type RelatedRecordsQuery = z.infer<typeof relatedRecordsSchema>;

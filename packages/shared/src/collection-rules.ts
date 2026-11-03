import { z } from "zod";
const whereSchema = z.record(z.string(), z.unknown());
const identity = {
  name: z.string().min(1).max(128),
  message: z.string().min(1).max(2048),
};
const bounds = {
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
};
const queryBounds = (rule: { min?: number; max?: number }) =>
  (rule.min !== undefined || rule.max !== undefined) &&
  !(rule.min !== undefined && rule.max !== undefined && rule.min > rule.max);
export const collectionValidationSchema = z.union([
  z.object({ ...identity, rule: z.string().min(1).max(8192) }).strict(),
  z
    .object({
      ...identity,
      ...bounds,
      count: z.object({ where: whereSchema.optional() }).strict(),
    })
    .strict()
    .refine(queryBounds, "Query rules require valid min/max bounds"),
  z
    .object({
      ...identity,
      ...bounds,
      sum: z
        .object({ field: z.string().min(1), where: whereSchema.optional() })
        .strict(),
    })
    .strict()
    .refine(queryBounds, "Query rules require valid min/max bounds"),
]);
export const collectionValidationsSchema = z
  .array(collectionValidationSchema)
  .max(100)
  .refine(
    (rules) => new Set(rules.map((rule) => rule.name)).size === rules.length,
    "Validation names must be unique",
  );
export type CollectionValidation = z.infer<typeof collectionValidationSchema>;

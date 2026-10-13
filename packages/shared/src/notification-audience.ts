import { z } from "zod";

import { InvalidQueryError } from "./errors";

export const notificationAudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self") }).strict(),
  z
    .object({
      kind: z.literal("users"),
      users: z.array(z.string().min(1).max(320)).min(1).max(200),
    })
    .strict(),
  z.object({ kind: z.literal("all") }).strict(),
  z
    .object({
      kind: z.literal("roles"),
      roles: z
        .array(
          z
            .string()
            .min(1)
            .max(64)
            .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
        )
        .min(1)
        .max(200),
    })
    .strict(),
]);

export type NotificationAudience = z.infer<typeof notificationAudienceSchema>;

export function storedNotificationAudience(
  value: unknown,
): NotificationAudience {
  const parsed = notificationAudienceSchema.safeParse(value);
  if (!parsed.success)
    throw new InvalidQueryError("Stored notification audience is malformed");
  return parsed.data;
}

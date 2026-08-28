import { genId } from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { syncMemberRole } from "./casbin";

export const USER_KINDS = ["human", "service"] as const;
export type UserKind = (typeof USER_KINDS)[number];

const serviceAccountSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "slug must contain lowercase letters, numbers, and single hyphens",
  );

export const createServiceAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: serviceAccountSlugSchema.optional(),
    email: z.string().email().optional(),
    role: z.enum(["admin", "member"]).default("member"),
  })
  .strict();

export type CreateServiceAccountInput = z.input<
  typeof createServiceAccountSchema
>;

const SERVICE_NOTIFICATION_PREFERENCES = {
  default: { in_app: true, email: false },
  by_kind: {},
} as const;

export function slugifyServiceAccountName(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64)
      .replace(/-$/g, "") || "service-account"
  );
}

export function serviceAccountPlaceholderEmail(
  slug: string,
  appUrl: string,
): string {
  const hostname = new URL(appUrl).hostname.toLowerCase();
  return `${slug}@service.${hostname}`;
}

export async function createServiceAccount(
  prisma: PrismaClient,
  appUrl: string,
  organizationId: string,
  input: CreateServiceAccountInput,
) {
  const parsed = createServiceAccountSchema.parse(input);
  const slug = parsed.slug ?? slugifyServiceAccountName(parsed.name);

  const result = await prisma.$transaction(async (transaction) => {
    // Placeholder addresses are derived from the name, so two accounts named
    // alike (in this org or any other) would collide on the unique email.
    let email = parsed.email ?? serviceAccountPlaceholderEmail(slug, appUrl);
    if (!parsed.email) {
      for (
        let suffix = 2;
        await transaction.user.findUnique({ where: { email } });
        suffix += 1
      ) {
        email = serviceAccountPlaceholderEmail(`${slug}-${suffix}`, appUrl);
      }
    }
    const user = await transaction.user.create({
      data: {
        id: genId(),
        kind: "service",
        name: parsed.name,
        email,
        emailVerified: Boolean(parsed.email),
        notificationPreferences:
          SERVICE_NOTIFICATION_PREFERENCES as unknown as Prisma.InputJsonValue,
      },
    });
    const member = await transaction.member.create({
      data: {
        id: genId(),
        organizationId,
        userId: user.id,
        role: parsed.role,
      },
    });
    return { user, member };
  });

  await syncMemberRole(
    prisma,
    organizationId,
    result.user.id,
    parsed.role,
    parsed.role,
  );
  return result;
}

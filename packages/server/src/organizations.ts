import type { AppServices } from "./services";
import { createAuditWriter } from "./db/audit";
import { bootstrapOrgPolicies } from "./db/casbin";
import { z } from "zod";

export const organizationSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "slug must contain lowercase letters, numbers, and single hyphens",
  );

export const createOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: organizationSlugSchema.optional(),
  })
  .strict();

export function slugifyOrganizationName(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64)
      .replace(/-$/g, "") || "organization"
  );
}

export class OrganizationSlugExistsError extends Error {
  constructor(readonly slug: string) {
    super(`An organization with slug '${slug}' already exists`);
  }
}

export async function createOrganizationForUser(
  services: Pick<AppServices, "auth" | "prisma">,
  userId: string,
  input: { name: string; slug?: string },
) {
  const { auth, prisma } = services;
  const slug = input.slug ?? slugifyOrganizationName(input.name);
  const existing = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (existing) throw new OrganizationSlugExistsError(slug);

  const organization = await auth.api.createOrganization({
    body: {
      name: input.name,
      slug,
      userId,
      keepCurrentActiveOrganization: true,
    },
  });
  await bootstrapOrgPolicies(prisma, organization.id, userId);
  await createAuditWriter(prisma, organization.id, userId)(
    "create_organization",
    "organization",
    organization.id,
    { slug },
  );
  return organization;
}

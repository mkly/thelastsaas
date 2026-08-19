import { errorResponse } from "@lastsaas/shared";
import { Hono } from "hono";
import { z } from "zod";

import { createAuditWriter } from "../db/audit";
import { bootstrapOrgPolicies } from "../db/casbin";
import type { AppEnvironment } from "../env";

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "slug must contain lowercase letters, numbers, and single hyphens",
  );
const createOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: slugSchema.optional(),
  })
  .strict();

function slugify(name: string): string {
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

export const organizationRouter = new Hono<AppEnvironment>()
  .get("/", async (context) => {
    const memberships = await context.get("services").prisma.member.findMany({
      where: { userId: context.get("userId") },
      orderBy: { createdAt: "asc" },
      select: {
        role: true,
        organization: {
          select: { id: true, name: true, slug: true, createdAt: true },
        },
      },
    });

    return context.json({
      status: "ok" as const,
      organizations: memberships.map(({ organization, role }) => ({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role,
        created_at: organization.createdAt.toISOString(),
      })),
    });
  })
  .post("/", async (context) => {
    const parsed = createOrganizationSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json(
        errorResponse(
          "ValidationError",
          parsed.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "body"}: ${issue.message}`,
            )
            .join("; "),
        ),
        400,
      );
    }

    const { auth, prisma } = context.get("services");
    const userId = context.get("userId");
    const slug = parsed.data.slug ?? slugify(parsed.data.name);
    const existing = await prisma.organization.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (existing) {
      return context.json(
        errorResponse(
          "OrganizationExists",
          `An organization with slug '${slug}' already exists`,
        ),
        409,
      );
    }

    const organization = await auth.api.createOrganization({
      body: {
        name: parsed.data.name,
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

    return context.json(
      {
        status: "ok" as const,
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          role: "admin",
          created_at: organization.createdAt.toISOString(),
        },
      },
      201,
    );
  });

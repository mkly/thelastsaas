import { errorResponse } from "@lastsaas/shared";
import { Hono } from "hono";

import type { AppEnvironment } from "../env";
import {
  createOrganizationForUser,
  createOrganizationSchema,
  OrganizationSlugExistsError,
} from "../organizations";

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

    const services = context.get("services");
    const userId = context.get("userId");
    let organization;
    try {
      organization = await createOrganizationForUser(
        services,
        userId,
        parsed.data,
      );
    } catch (error) {
      if (error instanceof OrganizationSlugExistsError) {
        return context.json(
          errorResponse("OrganizationExists", error.message),
          409,
        );
      }
      throw error;
    }

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

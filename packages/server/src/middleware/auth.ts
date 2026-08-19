import { errorResponse } from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import type { MiddlewareHandler } from "hono";

import type { Auth } from "../auth";
import { bootstrapOrgPolicies } from "../db/casbin";
import { ensurePersonalOrganization } from "../db/organizations";
import type { AppEnvironment } from "../env";

interface AuthMiddlewareDependencies {
  auth: Auth;
  prisma: PrismaClient;
}

export function createAuthMiddleware({
  auth,
  prisma,
}: AuthMiddlewareDependencies): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    const cliToken = authorization?.startsWith("Bearer lst_")
      ? authorization.slice("Bearer lst_".length)
      : null;
    const cliSession = cliToken
      ? await prisma.session.findUnique({
          where: { token: cliToken },
          select: {
            id: true,
            expiresAt: true,
            user: { select: { id: true, name: true } },
          },
        })
      : null;
    const session = cliToken
      ? cliSession && cliSession.expiresAt > new Date()
        ? { session: cliSession, user: cliSession.user }
        : null
      : await auth.api
          .getSession({ headers: context.req.raw.headers })
          .catch(() => null);

    if (!session?.session || !session.user) {
      return context.json(
        errorResponse("Unauthorized", "Missing or invalid authentication"),
        401,
      );
    }

    const personalOrganization = await ensurePersonalOrganization(
      prisma,
      auth,
      session.user,
    );
    if (personalOrganization.created) {
      await bootstrapOrgPolicies(
        prisma,
        personalOrganization.orgId,
        session.user.id,
      );
    }

    const orgId = context.req.param("orgId");
    if (!orgId) {
      return context.json(
        errorResponse("InvalidRequest", "Organization ID is required"),
        400,
      );
    }
    const membership = await prisma.member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: orgId,
          userId: session.user.id,
        },
      },
      select: { id: true },
    });
    if (!membership) {
      return context.json(
        errorResponse("Forbidden", "Organization membership required"),
        403,
      );
    }

    context.set("orgId", orgId);
    context.set("userId", session.user.id);
    await next();
  };
}

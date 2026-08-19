import { CollectionNotFoundError, errorResponse } from "@lastsaas/shared";
import type { Context, MiddlewareHandler } from "hono";

import { createOrgEnforcer, hasPermission } from "../db/casbin";
import { getCollection } from "../db/collections";
import { getRowFilter } from "../db/rowFilters";
import type { AppEnvironment } from "../env";

export type PermissionAction = "read" | "write" | "delete" | "manage";

export function requirePermission(
  action: PermissionAction,
  getResource: (context: Context<AppEnvironment>) => string,
): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const resource = getResource(context);
    const allowed = await hasPermission(
      context.get("services").prisma,
      context.get("orgId"),
      context.get("userId"),
      resource,
      action,
    );

    if (!allowed) {
      return context.json(
        errorResponse(
          "PermissionDenied",
          `User does not have ${action} permission on ${resource}`,
        ),
        403,
      );
    }

    await next();
  };
}

export function requireCollectionPermission(
  action: Exclude<PermissionAction, "manage">,
): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const prisma = context.get("services").prisma;
    const orgId = context.get("orgId");
    const userId = context.get("userId");
    const collectionName = context.req.param("name")!;
    const resource = `/collections/${collectionName}`;
    const enforcer = await createOrgEnforcer(prisma, orgId);

    if (!(await enforcer.enforce(userId, resource, action))) {
      return context.json(
        errorResponse(
          "PermissionDenied",
          `User does not have ${action} permission on ${resource}`,
        ),
        403,
      );
    }

    let rowFilter = null;
    try {
      const collection = await getCollection(prisma, orgId, collectionName);
      rowFilter = await getRowFilter(
        prisma,
        enforcer,
        { userId, userEmail: "", orgId },
        collection.id,
        resource,
        action,
        async () => {
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { email: true },
          });
          return user?.email ?? "";
        },
      );
    } catch (error) {
      if (!(error instanceof CollectionNotFoundError)) throw error;
    }

    context.set("rowFilter", rowFilter);
    await next();
  };
}

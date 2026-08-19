import { errorResponse } from "@lastsaas/shared";
import type { Context, MiddlewareHandler } from "hono";

import type { AppEnvironment } from "../env";
import { hasPermission } from "../db/casbin";

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
  return requirePermission(
    action,
    (context) => `/collections/${context.req.param("name")}`,
  );
}

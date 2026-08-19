import type { Hono } from "hono";

import type { AppEnvironment } from "../env";
import { collectionsRouter } from "./collections";
import { deviceAuthRouter } from "./device-auth";
import { healthRouter } from "./health";
import { notificationRouter } from "./notifications";
import { permissionRouter } from "./permissions";
import { systemRouter } from "./system";

export interface DomainRouter {
  basePath: string;
  router: Hono<AppEnvironment>;
}

// Domain tasks register their router by adding one entry to this list.
export const domainRouters: readonly DomainRouter[] = [
  { basePath: "/auth/device", router: deviceAuthRouter },
  { basePath: "/health", router: healthRouter },
  { basePath: "/v1/orgs/:orgId/collections", router: collectionsRouter },
  { basePath: "/v1/orgs/:orgId/notifications", router: notificationRouter },
  { basePath: "/v1/orgs/:orgId/permissions", router: permissionRouter },
  { basePath: "/v1/orgs/:orgId", router: systemRouter },
];

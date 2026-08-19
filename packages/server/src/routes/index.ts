import type { Hono } from "hono";

import type { AppEnvironment } from "../env";
import { collectionsRouter } from "./collections";
import { deviceAuthRouter } from "./device-auth";
import { fileRouter } from "./files";
import { healthRouter } from "./health";
import { invitationRouter } from "./invitations";
import { memberRouter } from "./members";
import { notificationScheduleRouter } from "./notification-schedules";
import { notificationRouter } from "./notifications";
import { organizationRouter } from "./organizations";
import { permissionRouter } from "./permissions";
import { recordsRouter } from "./records";
import { systemRouter } from "./system";

export interface DomainRouter {
  basePath: string;
  router: Hono<AppEnvironment>;
}

// Domain tasks register their router by adding one entry to this list.
export const domainRouters: readonly DomainRouter[] = [
  { basePath: "/auth/device", router: deviceAuthRouter },
  { basePath: "/health", router: healthRouter },
  { basePath: "/v1/orgs", router: organizationRouter },
  { basePath: "/v1/orgs/:orgId/collections", router: collectionsRouter },
  {
    basePath: "/v1/orgs/:orgId/collections/:name/records",
    router: recordsRouter,
  },
  { basePath: "/v1/orgs/:orgId/files", router: fileRouter },
  { basePath: "/v1/orgs/:orgId/invitations", router: invitationRouter },
  { basePath: "/v1/orgs/:orgId/members", router: memberRouter },
  {
    basePath: "/v1/orgs/:orgId/notifications/schedules",
    router: notificationScheduleRouter,
  },
  { basePath: "/v1/orgs/:orgId/notifications", router: notificationRouter },
  { basePath: "/v1/orgs/:orgId/permissions", router: permissionRouter },
  { basePath: "/v1/orgs/:orgId", router: systemRouter },
];

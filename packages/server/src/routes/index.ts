import type { Hono } from "hono";

import type { AppEnvironment } from "../env";
import { healthRouter } from "./health";
import { notificationScheduleRouter } from "./notification-schedules";

export interface DomainRouter {
  basePath: string;
  router: Hono<AppEnvironment>;
}

// Domain tasks register their router by adding one entry to this list.
export const domainRouters: readonly DomainRouter[] = [
  { basePath: "/health", router: healthRouter },
  {
    basePath: "/v1/orgs/:orgId/notifications/schedules",
    router: notificationScheduleRouter,
  },
];

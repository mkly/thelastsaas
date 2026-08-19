import type { Hono } from "hono";

import type { AppEnvironment } from "../env";
import { deviceAuthRouter } from "./device-auth";
import { healthRouter } from "./health";

export interface DomainRouter {
  basePath: string;
  router: Hono<AppEnvironment>;
}

// Domain tasks register their router by adding one entry to this list.
export const domainRouters: readonly DomainRouter[] = [
  { basePath: "/auth/device", router: deviceAuthRouter },
  { basePath: "/health", router: healthRouter },
];

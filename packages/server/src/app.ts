import { Hono } from "hono";

import type { AppConfig } from "./config";
import type { AppEnvironment } from "./env";
import { domainRouters } from "./routes";
import type { AppServices } from "./services";

export interface CreateAppOptions {
  config: AppConfig;
  services: AppServices;
}

export function createApp({
  config,
  services,
}: CreateAppOptions): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();

  app.use("*", async (context, next) => {
    context.set("config", config);
    context.set("services", services);
    await next();
  });

  for (const { basePath, router } of domainRouters) {
    app.route(basePath, router);
  }

  return app;
}

export type ApiType = ReturnType<typeof createApp>;

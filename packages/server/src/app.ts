import { Hono } from "hono";

import type { AppConfig } from "./config";
import type { AppEnvironment } from "./env";
import {
  createAccountAuthMiddleware,
  createAuthMiddleware,
} from "./middleware/auth";
import { domainRouters } from "./routes";
import { authPagesRouter } from "./routes/auth-pages";
import { downloadsRouter } from "./routes/downloads";
import { homeRouter } from "./routes/home";
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

  app.on(["GET", "POST"], "/api/auth/*", (context) =>
    services.auth.handler(context.req.raw),
  );

  app.route("/auth", authPagesRouter);
  app.route("/", downloadsRouter);
  app.route("/", homeRouter);

  const authMiddleware = createAuthMiddleware({
    auth: services.auth,
    prisma: services.prisma,
  });
  const accountAuthMiddleware = createAccountAuthMiddleware({
    auth: services.auth,
    prisma: services.prisma,
  });
  app.use("/v1/me", accountAuthMiddleware);
  app.use("/v1/orgs", accountAuthMiddleware);
  app.use("/v1/orgs/:orgId", authMiddleware);
  app.use("/v1/orgs/:orgId/*", authMiddleware);

  for (const { basePath, router } of domainRouters) {
    app.route(basePath, router);
  }

  return app;
}

export type ApiType = ReturnType<typeof createApp>;

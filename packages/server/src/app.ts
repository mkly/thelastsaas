import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import type { AppConfig } from "./config";
import type { AppEnvironment } from "./env";
import { THEME_COOKIE, parseTheme, withPageContext } from "./html";
import {
  createAccountAuthMiddleware,
  createAuthMiddleware,
} from "./middleware/auth";
import { createApiRateLimitMiddleware } from "./middleware/rate-limit";
import { domainRouters } from "./routes";
import { assetsRouter } from "./routes/assets";
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

  /* The page layout reads the pinned theme from here rather than from a
     parameter on every route. See `withPageContext` in ./html. */
  app.use("*", (context, next) =>
    withPageContext(
      parseTheme(getCookie(context, THEME_COOKIE)),
      context.req.path,
      next,
    ),
  );

  app.on(["GET", "POST"], "/api/auth/*", (context) =>
    services.auth.handler(context.req.raw),
  );
  app.on(["GET", "HEAD"], "/.well-known/*", (context) =>
    services.auth.handler(context.req.raw),
  );

  app.route("/auth", authPagesRouter);
  app.route("/", downloadsRouter);
  app.route("/", assetsRouter);
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
  app.use(
    "/v1/*",
    createApiRateLimitMiddleware({
      enabled: config.rateLimitEnabled,
      requests: config.rateLimitRequests,
      windowSeconds: config.rateLimitWindowSeconds,
    }),
  );

  for (const { basePath, router } of domainRouters) {
    app.route(basePath, router);
  }

  return app;
}

export type ApiType = ReturnType<typeof createApp>;

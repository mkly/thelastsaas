import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";

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
import { log } from "./logger";
import type { AppServices } from "./services";

export interface CreateAppOptions {
  config: AppConfig;
  services: AppServices;
  /* Request logging to stdout (journald in production). Off by default so
     tests stay quiet; the server entry point turns it on. */
  logRequests?: boolean;
}

export function createApp({
  config,
  services,
  logRequests = false,
}: CreateAppOptions): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();

  if (logRequests) {
    app.use(
      "*",
      logger((line, ...rest) => log.info("http", line, ...rest)),
    );
  }

  /* Hono's default handler prints the error without any request context.
     HTTPExceptions are deliberate responses, not faults — pass them through. */
  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    log.error(
      "http",
      `unhandled error on ${context.req.method} ${context.req.path}`,
      error,
    );
    return context.text("Internal Server Error", 500);
  });

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

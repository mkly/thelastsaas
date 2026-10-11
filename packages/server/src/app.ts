import { errorKind } from "./lib/transport";
import { errorResponse } from "@lastsaas/shared";
import { uploadRouter } from "./routes/uploads";
import { fileDownloadsRouter } from "./routes/file-downloads";
import { installRouter } from "./routes/install";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";

import type { AppConfig } from "./config";
import type { AppEnvironment } from "./env";
import { THEME_COOKIE, parseTheme, withPageContext } from "./html";
import {
  createAccountAuthMiddleware,
  createAuthMiddleware,
} from "./middleware/auth";
import { createApiRateLimitMiddleware } from "./middleware/rate-limit";
import { apiRouter } from "./routes";
import { assetsRouter } from "./routes/assets";
import { authPagesRouter } from "./routes/auth-pages";
import { downloadsRouter } from "./routes/downloads";
import { homeRouter } from "./routes/home";
import { tokenClaimRouter } from "./routes/token-claims";
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

  app.use("/v1/*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  if (logRequests)
    app.use("*", async (context, next) => {
      await next();
      log.info(
        "http",
        `${context.req.method} ${context.req.routePath} ${context.res.status}`,
      );
    });
  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      if (error.status === 400)
        return context.json(
          errorResponse("SchemaValidationError", "Malformed request"),
          400,
        );
      return error.getResponse();
    }
    log.error(
      "http",
      `${context.req.method} ${context.req.routePath}: ${errorKind(error)}`,
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

  app.route("/uploads", uploadRouter);
  app.route("/file-downloads", fileDownloadsRouter);
  app.route("/auth", authPagesRouter);
  app.route("/", installRouter);
  app.route("/", downloadsRouter);
  app.route("/", assetsRouter);
  app.route("/", homeRouter);
  app.route("/", tokenClaimRouter);

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

  return app.route("/", apiRouter);
}

export type ApiType = typeof apiRouter;

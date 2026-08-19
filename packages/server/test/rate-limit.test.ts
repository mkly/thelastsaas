import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { AppEnvironment } from "../src/env";
import { createApiRateLimitMiddleware } from "../src/middleware/rate-limit";

function createLimitedApp(options?: {
  enabled?: boolean;
  requests?: number;
  windowSeconds?: number;
}) {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (context, next) => {
    context.set("userId", context.req.header("X-Test-User") ?? "user_123");
    await next();
  });
  app.use(
    "/v1/*",
    createApiRateLimitMiddleware({
      enabled: options?.enabled ?? true,
      requests: options?.requests ?? 2,
      windowSeconds: options?.windowSeconds ?? 60,
    }),
  );
  app.get("/v1/probe", (context) => context.json({ status: "ok" }));
  app.get("/auth/probe", (context) => context.json({ status: "ok" }));
  return app;
}

describe("API rate limiting", () => {
  test("allows a configured burst and returns rate limit headers", async () => {
    const app = createLimitedApp();

    const first = await app.request("/v1/probe");
    const second = await app.request("/v1/probe");

    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(first.headers.get("X-RateLimit-Remaining")).toBe("1");
    expect(second.status).toBe(200);
    expect(second.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  test("returns 429 after the per-user ceiling is exceeded", async () => {
    const app = createLimitedApp({ requests: 1 });

    expect((await app.request("/v1/probe")).status).toBe(200);
    const response = await app.request("/v1/probe");

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).not.toBeNull();
    expect(await response.json()).toMatchObject({
      status: "error",
      error: "RateLimitExceeded",
    });
  });

  test("tracks authenticated users independently", async () => {
    const app = createLimitedApp({ requests: 1 });

    expect(
      (
        await app.request("/v1/probe", {
          headers: { "X-Test-User": "user_a" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/v1/probe", {
          headers: { "X-Test-User": "user_b" },
        })
      ).status,
    ).toBe(200);
  });

  test("does not apply to authentication routes", async () => {
    const app = createLimitedApp({ requests: 1 });

    expect((await app.request("/auth/probe")).status).toBe(200);
    expect((await app.request("/auth/probe")).status).toBe(200);
  });

  test("can be disabled for a trusted installation", async () => {
    const app = createLimitedApp({ enabled: false, requests: 1 });

    expect((await app.request("/v1/probe")).status).toBe(200);
    expect((await app.request("/v1/probe")).status).toBe(200);
  });
});

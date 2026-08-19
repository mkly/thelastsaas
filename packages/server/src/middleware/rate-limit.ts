import { errorResponse } from "@lastsaas/shared";
import type { MiddlewareHandler } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";

import type { AppEnvironment } from "../env";

interface ApiRateLimitOptions {
  enabled: boolean;
  requests: number;
  windowSeconds: number;
}

interface RateLimitRejection {
  msBeforeNext: number;
  remainingPoints: number;
}

function isRateLimitRejection(value: unknown): value is RateLimitRejection {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "msBeforeNext") === "number" &&
    typeof Reflect.get(value, "remainingPoints") === "number"
  );
}

function setRateLimitHeaders(
  headers: Headers,
  limit: number,
  remaining: number,
  msBeforeNext: number,
): void {
  headers.set("X-RateLimit-Limit", String(limit));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, remaining)));
  headers.set(
    "X-RateLimit-Reset",
    String(Math.ceil((Date.now() + msBeforeNext) / 1_000)),
  );
}

/**
 * A generous safety ceiling for authenticated application traffic. Better Auth
 * owns rate limiting for its own routes; this middleware is only mounted under
 * /v1 after authentication has resolved the user.
 */
export function createApiRateLimitMiddleware({
  enabled,
  requests,
  windowSeconds,
}: ApiRateLimitOptions): MiddlewareHandler<AppEnvironment> {
  if (!enabled) return async (_context, next) => next();

  const limiter = new RateLimiterMemory({
    keyPrefix: "lastsaas-api",
    points: requests,
    duration: windowSeconds,
  });

  return async (context, next) => {
    try {
      const result = await limiter.consume(context.get("userId"));
      setRateLimitHeaders(
        context.res.headers,
        requests,
        result.remainingPoints,
        result.msBeforeNext,
      );
      await next();
    } catch (error) {
      if (!isRateLimitRejection(error)) throw error;

      const retryAfter = Math.max(1, Math.ceil(error.msBeforeNext / 1_000));
      setRateLimitHeaders(
        context.res.headers,
        requests,
        error.remainingPoints,
        error.msBeforeNext,
      );
      context.header("Retry-After", String(retryAfter));
      return context.json(
        errorResponse(
          "RateLimitExceeded",
          `API request rate exceeded; retry in ${retryAfter} seconds`,
        ),
        429,
      );
    }
  };
}

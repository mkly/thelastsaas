import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";

const productionSecret = "a".repeat(32);

describe("auth configuration", () => {
  test("falls back to local development auth defaults", () => {
    const config = loadConfig({ PORT: "9000" });

    expect(config.betterAuthUrl).toBe("http://localhost:9000");
    expect(config.betterAuthSecret).not.toBe("");
    expect(config.googleClientId).toBe("");
    expect(config.maxUploadSize).toBe(50 * 1024 * 1024);
    expect(config.rateLimitEnabled).toBe(true);
    expect(config.rateLimitRequests).toBe(6_000);
    expect(config.rateLimitWindowSeconds).toBe(60);
  });

  test("requires a BetterAuth secret in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://app.example.com",
      }),
    ).toThrow("BETTER_AUTH_SECRET is required in production");
  });

  test("requires a BetterAuth URL in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: productionSecret,
      }),
    ).toThrow("BETTER_AUTH_URL is required in production");
  });

  test("accepts a fully configured production environment", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: productionSecret,
      BETTER_AUTH_URL: "https://app.example.com",
    });

    expect(config.betterAuthSecret).toBe(productionSecret);
    expect(config.betterAuthUrl).toBe("https://app.example.com");
  });

  test("rejects a half-configured Google provider", () => {
    expect(() => loadConfig({ GOOGLE_CLIENT_ID: "client-id" })).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be provided together",
    );
  });

  test("parses a positive upload limit in bytes", () => {
    expect(loadConfig({ MAX_UPLOAD_SIZE: "1048576" }).maxUploadSize).toBe(
      1_048_576,
    );
    expect(() => loadConfig({ MAX_UPLOAD_SIZE: "0" })).toThrow();
  });

  test("parses API rate limit settings", () => {
    const config = loadConfig({
      RATE_LIMIT_ENABLED: "false",
      RATE_LIMIT_REQUESTS: "12000",
      RATE_LIMIT_WINDOW_SECONDS: "120",
    });

    expect(config.rateLimitEnabled).toBe(false);
    expect(config.rateLimitRequests).toBe(12_000);
    expect(config.rateLimitWindowSeconds).toBe(120);
    expect(() => loadConfig({ RATE_LIMIT_REQUESTS: "0" })).toThrow();
    expect(() => loadConfig({ RATE_LIMIT_WINDOW_SECONDS: "0" })).toThrow();
  });
});

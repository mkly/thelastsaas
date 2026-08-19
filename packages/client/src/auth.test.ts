import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { login } from "./auth";
import { loadConfig, saveConfig } from "./config";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("login", () => {
  test("runs RFC 8628 device authorization and stores the access token unchanged", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lastsaas-auth-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    saveConfig(
      { org: "org_default", server: "http://example.com" },
      configPath,
    );

    const requests: Array<{ path: string; body: Record<string, string> }> = [];
    const sleeps: number[] = [];
    const statuses: string[] = [];
    let openedUrl = "";
    let tokenPolls = 0;
    const now = Date.parse("2026-08-19T12:00:00.000Z");

    const result = await login("http://example.com/", {
      configPath,
      now: () => now,
      onStatus: (message) => {
        statuses.push(message);
      },
      openBrowser: (url) => {
        openedUrl = url;
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        requests.push({ path: url.pathname, body });

        if (url.pathname === "/api/auth/device/code") {
          return Response.json({
            device_code: "device-secret",
            user_code: "ABCD-EFGH",
            verification_uri: "http://example.com/auth/device",
            verification_uri_complete:
              "http://example.com/auth/device?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 5,
          });
        }

        tokenPolls += 1;
        if (tokenPolls === 1) {
          return Response.json(
            {
              error: "authorization_pending",
              error_description: "Authorization pending",
            },
            { status: 400 },
          );
        }
        return Response.json({
          access_token: "better-auth-session-token",
          token_type: "Bearer",
          expires_in: 7_776_000,
          scope: "",
        });
      },
    });

    expect(openedUrl).toBe(
      "http://example.com/auth/device?user_code=ABCD-EFGH",
    );
    expect(statuses).toEqual([
      "Device code: ABCD-EFGH",
      "Open this URL to authorize the CLI: http://example.com/auth/device?user_code=ABCD-EFGH",
    ]);
    expect(sleeps).toEqual([5_000, 5_000]);
    expect(requests).toEqual([
      {
        path: "/api/auth/device/code",
        body: { client_id: "lastsaas-cli" },
      },
      {
        path: "/api/auth/device/token",
        body: {
          client_id: "lastsaas-cli",
          device_code: "device-secret",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      },
      {
        path: "/api/auth/device/token",
        body: {
          client_id: "lastsaas-cli",
          device_code: "device-secret",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      },
    ]);
    expect(result).toEqual({
      expiresAt: "2026-11-17T12:00:00.000Z",
      server: "http://example.com",
      sessionToken: "better-auth-session-token",
    });
    expect(loadConfig(configPath)).toEqual({
      expires_at: "2026-11-17T12:00:00.000Z",
      org: "org_default",
      server: "http://example.com",
      session_token: "better-auth-session-token",
    });
  });

  test("honors slow_down and reports terminal device errors", async () => {
    let polls = 0;
    const sleeps: number[] = [];
    await expect(
      login("https://example.com", {
        now: () => 0,
        onStatus: () => undefined,
        openBrowser: () => undefined,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        fetchImpl: async (input) => {
          if (new URL(String(input)).pathname.endsWith("/code")) {
            return Response.json({
              device_code: "device-secret",
              user_code: "ABCD-EFGH",
              verification_uri: "https://example.com/auth/device",
              verification_uri_complete:
                "https://example.com/auth/device?user_code=ABCD-EFGH",
              expires_in: 600,
              interval: 5,
            });
          }
          polls += 1;
          return polls === 1
            ? Response.json(
                { error: "slow_down", error_description: "Slow down" },
                { status: 400 },
              )
            : Response.json(
                { error: "access_denied", error_description: "Denied" },
                { status: 400 },
              );
        },
      }),
    ).rejects.toThrow("Device authorization failed: Denied");
    expect(sleeps).toEqual([5_000, 10_000]);
  });
});

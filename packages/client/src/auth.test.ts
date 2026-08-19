import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exchangeDeviceToken,
  generateCodeChallenge,
  generateCodeVerifier,
  login,
} from "./auth";
import { loadConfig, saveConfig } from "./config";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("generateCodeVerifier", () => {
  test("produces unique base64url values of at least 43 characters", () => {
    const first = generateCodeVerifier();
    const second = generateCodeVerifier();

    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.length).toBeGreaterThanOrEqual(43);
    expect(first).not.toBe(second);
  });
});

describe("generateCodeChallenge", () => {
  test("matches the RFC 7636 Appendix B test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    expect(await generateCodeChallenge(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(await generateCodeChallenge(verifier)).toBe(
      await generateCodeChallenge(verifier),
    );
  });
});

describe("exchangeDeviceToken", () => {
  const payload = {
    code: "code-123",
    code_verifier: "verifier-123",
    redirect_uri: "http://127.0.0.1:44501/callback",
  };

  test("replays POST to an HTTPS redirect and returns its effective origin", async () => {
    let callCount = 0;
    const fetchImpl = async (
      input: Request | string | URL,
      init?: RequestInit,
    ) => {
      callCount += 1;
      if (callCount === 1) {
        expect(String(input)).toBe("http://example.com/auth/device/token");
        expect(init?.method).toBe("POST");
        return new Response(null, {
          headers: { location: "https://example.com/auth/device/token" },
          status: 301,
        });
      }

      expect(String(input)).toBe("https://example.com/auth/device/token");
      expect(init?.method).toBe("POST");
      return Response.json({
        expires_at: "2026-05-01T00:00:00.000Z",
        session_token: "lst_123",
        status: "ok",
      });
    };

    const result = await exchangeDeviceToken(
      "http://example.com",
      payload,
      fetchImpl,
    );

    expect(result.effectiveServerUrl).toBe("https://example.com");
    expect(result.tokenData.session_token).toBe("lst_123");
  });

  test("throws a clearer error for non-JSON token responses", async () => {
    const fetchImpl = async () =>
      new Response("<html>Moved</html>", {
        headers: { "content-type": "text/html" },
        status: 200,
      });

    await expect(
      exchangeDeviceToken("http://example.com", payload, fetchImpl),
    ).rejects.toThrow("Token exchange returned 200 with non-JSON response.");
  });
});

describe("login", () => {
  test("runs the PKCE flow and stores the lst_ token without losing org config", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lastsaas-auth-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    saveConfig(
      { org: "org_default", server: "http://example.com" },
      configPath,
    );
    let authorizeUrl: URL | undefined;
    let callbackClosed = false;

    const result = await login("http://example.com/", {
      configPath,
      fetchImpl: async (_input, init) => {
        const payload = JSON.parse(String(init?.body)) as Record<
          string,
          string
        >;
        const expectedChallenge =
          authorizeUrl?.searchParams.get("code_challenge");
        if (!expectedChallenge) throw new Error("authorize URL was not opened");
        expect(payload.code).toBe("authorization-code");
        expect(payload.redirect_uri).toBe("http://127.0.0.1:41234/callback");
        expect(await generateCodeChallenge(payload.code_verifier)).toBe(
          expectedChallenge,
        );
        return Response.json({
          expires_at: "2026-05-01T00:00:00.000Z",
          session_token: "lst_secret",
          status: "ok",
        });
      },
      onStatus: () => undefined,
      openBrowser: (url) => {
        authorizeUrl = new URL(url);
      },
      startCallbackServer: async () => ({
        close: () => {
          callbackClosed = true;
        },
        port: 41234,
        waitForCode: async () => ({
          code: "authorization-code",
          state: authorizeUrl?.searchParams.get("state") ?? "",
        }),
      }),
    });

    expect(result.server).toBe("http://example.com");
    expect(callbackClosed).toBe(true);
    expect(loadConfig(configPath)).toEqual({
      expires_at: "2026-05-01T00:00:00.000Z",
      org: "org_default",
      server: "http://example.com",
      session_token: "lst_secret",
    });
  });
});

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

import {
  loadConfig,
  normalizeServerUrl,
  saveConfig,
  type ClientConfig,
} from "./config";
import { CliError } from "./errors";

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

export interface DeviceTokenResponse {
  error?: string;
  expires_at?: string;
  session_token?: string;
  status: string;
}

export interface LoginResult {
  expiresAt?: string;
  server: string;
  sessionToken: string;
}

export interface CallbackServer {
  close(): void;
  port: number;
  waitForCode(): Promise<{ code: string; state: string }>;
}

export type FetchImplementation = (
  input: Request | string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface LoginDependencies {
  configPath?: string;
  fetchImpl?: FetchImplementation;
  onStatus?: (message: string) => void;
  openBrowser?: (url: string) => void;
  startCallbackServer?: () => Promise<CallbackServer>;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function generateCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

export async function exchangeDeviceToken(
  serverUrl: string,
  payload: {
    code: string;
    code_verifier: string;
    redirect_uri: string;
  },
  fetchImpl: FetchImplementation = fetch,
): Promise<{
  effectiveServerUrl: string;
  tokenData: DeviceTokenResponse;
}> {
  let tokenUrl = `${normalizeServerUrl(serverUrl)}/auth/device/token`;
  const requestBody = JSON.stringify(payload);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(tokenUrl, {
      body: requestBody,
      headers: { "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new CliError(
          "Token exchange redirected without a usable location.",
        );
      }

      const current = new URL(tokenUrl);
      const redirected = new URL(location, current);
      if (
        !["http:", "https:"].includes(redirected.protocol) ||
        redirected.hostname !== current.hostname ||
        (current.protocol === "https:" && redirected.protocol !== "https:")
      ) {
        throw new CliError("Token exchange refused an unsafe redirect.");
      }
      tokenUrl = redirected.toString();
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new CliError(
        `Token exchange returned ${response.status} with non-JSON response.`,
      );
    }

    let tokenData: DeviceTokenResponse;
    try {
      tokenData = (await response.json()) as DeviceTokenResponse;
    } catch (error) {
      throw new CliError("Token exchange returned invalid JSON.", 1, {
        cause: error,
      });
    }
    return {
      effectiveServerUrl: new URL(tokenUrl).origin,
      tokenData,
    };
  }

  throw new CliError("Token exchange redirected too many times.");
}

export function openBrowser(url: string): void {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  // The URL is printed before this runs, so a missing opener should not crash
  // the CLI or prevent the user from completing the flow manually.
  child.once("error", () => undefined);
  child.unref();
}

export async function login(
  serverUrl: string,
  dependencies: LoginDependencies = {},
): Promise<LoginResult> {
  const baseServerUrl = normalizeServerUrl(serverUrl);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = base64Url(randomBytes(16));
  const callback = await (
    dependencies.startCallbackServer ?? startCallbackServer
  )();
  const onStatus = dependencies.onStatus ?? console.error;

  try {
    const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
    const params = new URLSearchParams({
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      state,
    });
    const authorizeUrl = `${baseServerUrl}/auth/device/authorize?${params.toString()}`;

    onStatus("Opening browser for authentication...");
    onStatus(`If the browser doesn't open, visit: ${authorizeUrl}`);
    (dependencies.openBrowser ?? openBrowser)(authorizeUrl);

    const result = await callback.waitForCode();
    if (!result.code) {
      throw new CliError("Authentication callback did not include a code.");
    }
    if (result.state !== state) {
      throw new CliError("State mismatch - possible CSRF attack.");
    }

    const { effectiveServerUrl, tokenData } = await exchangeDeviceToken(
      baseServerUrl,
      {
        code: result.code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      },
      dependencies.fetchImpl,
    );

    if (
      tokenData.status !== "ok" ||
      !tokenData.session_token?.startsWith("lst_")
    ) {
      throw new CliError(
        `Token exchange failed: ${tokenData.error ?? "Invalid response"}`,
      );
    }

    const previousConfig = loadConfig(dependencies.configPath);
    const config: ClientConfig = {
      ...previousConfig,
      expires_at: tokenData.expires_at,
      server: effectiveServerUrl,
      session_token: tokenData.session_token,
    };
    saveConfig(config, dependencies.configPath);

    return {
      expiresAt: tokenData.expires_at,
      server: effectiveServerUrl,
      sessionToken: tokenData.session_token,
    };
  } finally {
    callback.close();
  }
}

export function startCallbackServer(
  timeoutMs = CALLBACK_TIMEOUT_MS,
): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let resolveCode: (value: { code: string; state: string }) => void;
    let rejectCode: (reason: Error) => void;
    let settled = false;
    const codePromise = new Promise<{ code: string; state: string }>(
      (resolveCallback, rejectCallback) => {
        resolveCode = resolveCallback;
        rejectCode = rejectCallback;
      },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectCode(new CliError("Timed out waiting for browser authentication."));
    }, timeoutMs);

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!code || !state) {
        response.writeHead(400, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Authentication callback is missing code or state.");
        return;
      }

      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><h1>Authentication successful</h1><p>You can close this tab and return to the CLI.</p></body></html>",
      );
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolveCode({ code, state });
      }
    });

    server.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new CliError("Could not start the login callback server.", 1, {
          cause: error,
        }),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        clearTimeout(timer);
        server.close();
        reject(new CliError("Could not determine the login callback port."));
        return;
      }
      resolve({
        close: () => {
          clearTimeout(timer);
          server.close();
        },
        port: address.port,
        waitForCode: () => codePromise,
      });
    });
  });
}

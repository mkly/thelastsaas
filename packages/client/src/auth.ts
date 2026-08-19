import { spawn } from "node:child_process";

import {
  loadConfig,
  normalizeServerUrl,
  saveConfig,
  type ClientConfig,
} from "./config";
import { CliError } from "./errors";

const CLIENT_ID = "lastsaas-cli";
const DEVICE_CODE_PATH = "/api/auth/device/code";
const DEVICE_TOKEN_PATH = "/api/auth/device/token";
const DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code" as const;

export interface DeviceCodeResponse {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
}

export interface DeviceTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface LoginResult {
  expiresAt?: string;
  server: string;
  sessionToken: string;
}

export type FetchImplementation = (
  input: Request | string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface LoginDependencies {
  configPath?: string;
  fetchImpl?: FetchImplementation;
  now?: () => number;
  onStatus?: (message: string) => void;
  openBrowser?: (url: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface JsonPostResult<T> {
  effectiveServerUrl: string;
  response: Response;
  value: T;
}

function serverUrlFromEndpoint(
  endpointUrl: string,
  endpointPath: string,
): string {
  const url = new URL(endpointUrl);
  url.search = "";
  url.hash = "";
  if (url.pathname.endsWith(endpointPath)) {
    url.pathname = url.pathname.slice(0, -endpointPath.length);
  }
  return normalizeServerUrl(url.toString());
}

async function postJson<T>(
  serverUrl: string,
  endpointPath: string,
  body: unknown,
  fetchImpl: FetchImplementation,
): Promise<JsonPostResult<T>> {
  let endpointUrl = `${normalizeServerUrl(serverUrl)}${endpointPath}`;
  const requestBody = JSON.stringify(body);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(endpointUrl, {
      body: requestBody,
      headers: { "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new CliError("Authentication redirected without a location.");
      }
      const current = new URL(endpointUrl);
      const redirected = new URL(location, current);
      if (
        !["http:", "https:"].includes(redirected.protocol) ||
        redirected.hostname !== current.hostname ||
        (current.protocol === "https:" && redirected.protocol !== "https:")
      ) {
        throw new CliError("Authentication refused an unsafe redirect.");
      }
      endpointUrl = redirected.toString();
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new CliError(
        `Authentication returned ${response.status} with a non-JSON response.`,
      );
    }

    try {
      return {
        effectiveServerUrl: serverUrlFromEndpoint(endpointUrl, endpointPath),
        response,
        value: (await response.json()) as T,
      };
    } catch (error) {
      throw new CliError("Authentication returned invalid JSON.", 1, {
        cause: error,
      });
    }
  }

  throw new CliError("Authentication redirected too many times.");
}

export function openBrowser(url: string): void {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

export async function login(
  serverUrl: string,
  dependencies: LoginDependencies = {},
): Promise<LoginResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? Date.now;
  const onStatus = dependencies.onStatus ?? console.error;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const codeResult = await postJson<DeviceCodeResponse>(
    serverUrl,
    DEVICE_CODE_PATH,
    { client_id: CLIENT_ID },
    fetchImpl,
  );
  if (!codeResult.response.ok || !codeResult.value.device_code) {
    throw new CliError("The server could not start device authorization.");
  }

  const device = codeResult.value;
  onStatus(`Device code: ${device.user_code}`);
  onStatus(`Open this URL to authorize the CLI: ${device.verification_uri}`);
  (dependencies.openBrowser ?? openBrowser)(device.verification_uri_complete);

  const deadline = now() + device.expires_in * 1000;
  let intervalMilliseconds = device.interval * 1000;
  let tokenData: DeviceTokenResponse | undefined;
  let effectiveServerUrl = codeResult.effectiveServerUrl;

  while (now() < deadline) {
    await sleep(intervalMilliseconds);
    const tokenResult = await postJson<DeviceTokenResponse>(
      effectiveServerUrl,
      DEVICE_TOKEN_PATH,
      {
        client_id: CLIENT_ID,
        device_code: device.device_code,
        grant_type: DEVICE_GRANT_TYPE,
      },
      fetchImpl,
    );
    effectiveServerUrl = tokenResult.effectiveServerUrl;
    tokenData = tokenResult.value;
    if (tokenResult.response.ok && tokenData.access_token) break;
    if (tokenData.error === "authorization_pending") continue;
    if (tokenData.error === "slow_down") {
      intervalMilliseconds += 5_000;
      continue;
    }
    throw new CliError(
      `Device authorization failed: ${tokenData.error_description ?? tokenData.error ?? "Invalid response"}`,
    );
  }

  if (
    !tokenData?.access_token ||
    tokenData.token_type?.toLowerCase() !== "bearer"
  ) {
    throw new CliError(
      "Device authorization timed out or returned an invalid token.",
    );
  }

  const expiresAt = tokenData.expires_in
    ? new Date(now() + tokenData.expires_in * 1000).toISOString()
    : undefined;
  const previousConfig = loadConfig(dependencies.configPath);
  const config: ClientConfig = {
    ...previousConfig,
    expires_at: expiresAt,
    server: effectiveServerUrl,
    session_token: tokenData.access_token,
  };
  saveConfig(config, dependencies.configPath);

  return {
    expiresAt,
    server: effectiveServerUrl,
    sessionToken: tokenData.access_token,
  };
}

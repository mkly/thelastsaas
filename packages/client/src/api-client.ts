import type { ApiType } from "@lastsaas/server/api";
import { hc } from "hono/client";

import type { GlobalOptions } from "./index";
import {
  loadConfig,
  normalizeServerUrl,
  resolveOrgId,
  resolveServerUrl,
  type ClientConfig,
} from "./config";
import { CliError, ReauthenticationRequiredError } from "./errors";

export type ApiClient = ReturnType<typeof createApiClient>;

export interface AuthenticatedClient {
  client: ApiClient;
  config: ClientConfig;
}

export interface OrganizationClient extends AuthenticatedClient {
  orgId: string;
}

export function createApiClient(
  serverUrl: string,
  token: string,
): ReturnType<typeof hc<ApiType>> {
  return hc<ApiType>(normalizeServerUrl(serverUrl), {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function getClient(config = loadConfig()): AuthenticatedClient {
  if (!config?.session_token) {
    throw new CliError("Not logged in. Run `saas login` first.");
  }

  return {
    client: createApiClient(resolveServerUrl(config), config.session_token),
    config,
  };
}

export function getOrgClient(
  options: Pick<GlobalOptions, "org"> = {},
  config = loadConfig(),
): OrganizationClient {
  const authenticated = getClient(config);
  return {
    ...authenticated,
    orgId: resolveOrgId(config, options.org),
  };
}

export async function handleResponse<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  if (response.status === 401) throw new ReauthenticationRequiredError();

  const data = await readResponseBody(response);
  if (!response.ok || isErrorEnvelope(data)) {
    throw new CliError(errorMessage(data, response));
  }
  return data as T;
}

export function withErrorHandling<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    try {
      await action(...args);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
        throw new CliError("Could not connect to the Last SaaS server.", 1, {
          cause: error,
        });
      }
      throw error;
    }
  };
}

export function parseJson<T = unknown>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new CliError(`${label} must be valid JSON.`, 1, { cause: error });
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (!response.ok)
      return { message: `HTTP ${response.status} ${response.statusText}` };
    throw new CliError("The server returned an invalid JSON response.", 1, {
      cause: error,
    });
  }
}

function isErrorEnvelope(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).status === "error"
  );
}

function errorMessage(value: unknown, response: Response): string {
  if (value && typeof value === "object") {
    const body = value as Record<string, unknown>;
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  }
  return `HTTP ${response.status} ${response.statusText}`.trim();
}

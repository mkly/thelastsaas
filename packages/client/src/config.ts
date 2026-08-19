import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CliError } from "./errors";

export const DEFAULT_SERVER_URL = "http://localhost:8787";

export interface ClientConfig {
  org?: string;
  server: string;
  session_token?: string;
}

export function getConfigPath(): string {
  return join(homedir(), ".lastsaas", "config.json");
}

export function loadConfig(path = getConfigPath()): ClientConfig | null {
  if (!existsSync(path)) return null;

  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isClientConfig(value)) {
      throw new CliError(`Invalid Last SaaS config at ${path}.`);
    }
    return value;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Could not read Last SaaS config at ${path}.`, 1, {
      cause: error,
    });
  }
}

export function saveConfig(config: ClientConfig, path = getConfigPath()): void {
  if (!isClientConfig(config)) {
    throw new CliError("Refusing to save an invalid Last SaaS config.");
  }

  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function clearConfig(path = getConfigPath()): void {
  if (existsSync(path)) unlinkSync(path);
}

export function resolveServerUrl(config: ClientConfig | null): string {
  return normalizeServerUrl(config?.server ?? DEFAULT_SERVER_URL);
}

export function resolveOrgId(
  config: ClientConfig | null,
  explicitOrg?: string,
): string {
  const orgId = explicitOrg?.trim() || config?.org?.trim();
  if (!orgId) {
    throw new CliError(
      "No organization selected. Pass `--org <org-id>` or set `org` in ~/.lastsaas/config.json.",
    );
  }
  return orgId;
}

export function normalizeServerUrl(server: string): string {
  const trimmed = server.trim().replace(/\/+$/, "");
  if (!trimmed) throw new CliError("The configured server URL is empty.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new CliError(`Invalid server URL: ${server}`, 1, { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`Server URL must use http or https: ${server}`);
  }
  return url.toString().replace(/\/$/, "");
}

function isClientConfig(value: unknown): value is ClientConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.server === "string" &&
    (config.session_token === undefined ||
      typeof config.session_token === "string") &&
    (config.org === undefined || typeof config.org === "string")
  );
}

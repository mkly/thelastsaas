import { getOrgClient, handleResponse } from "../api-client";
import type { FetchImplementation } from "../auth";
import { loadConfig, resolveServerUrl } from "../config";
import { writeOutput, type OutputOptions } from "../output";

export interface WhoAmIDependencies {
  configPath?: string;
  fetchImpl?: FetchImplementation;
}

export interface WhoAmIResult {
  organization: string;
  server: string;
  session_expires_at?: string;
  stats: Record<string, unknown>;
}

export async function whoami(
  options: OutputOptions & { org?: string } = {},
  dependencies: WhoAmIDependencies = {},
): Promise<WhoAmIResult> {
  const { config, orgId } = getOrgClient(
    { org: options.org },
    loadConfig(dependencies.configPath),
  );
  const server = resolveServerUrl(config);
  const response = await (dependencies.fetchImpl ?? fetch)(
    `${server}/v1/orgs/${encodeURIComponent(orgId)}/stats`,
    { headers: { Authorization: `Bearer ${config.session_token}` } },
  );
  const stats = await handleResponse<Record<string, unknown>>(response);
  const result: WhoAmIResult = {
    organization: orgId,
    server,
    session_expires_at: config.expires_at,
    stats,
  };

  writeOutput(
    result,
    options,
    [
      `Server: ${server}`,
      `Organization: ${orgId}`,
      `Session expires: ${config.expires_at ?? "unknown"}`,
      `Stats: ${JSON.stringify(stats, null, 2)}`,
    ].join("\n"),
  );
  return result;
}

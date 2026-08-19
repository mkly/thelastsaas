import { getOrgClient, handleResponse } from "../api-client";
import type { FetchImplementation } from "../auth";
import { loadConfig, resolveServerUrl } from "../config";
import { CliError } from "../errors";
import { writeOutput, type OutputOptions } from "../output";

export interface WhoAmIDependencies {
  configPath?: string;
  fetchImpl?: FetchImplementation;
}

export interface WhoAmIResult {
  organization: string;
  organization_name: string;
  role: string;
  server: string;
  session_expires_at?: string;
}

interface OrganizationMembership {
  id: string;
  name: string;
  role: string;
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
    `${server}/v1/orgs`,
    { headers: { Authorization: `Bearer ${config.session_token}` } },
  );
  const memberships = await handleResponse<{
    organizations: OrganizationMembership[];
  }>(response);
  const membership = memberships.organizations.find(({ id }) => id === orgId);
  if (!membership) {
    throw new CliError(`You are not a member of organization '${orgId}'.`);
  }
  const result: WhoAmIResult = {
    organization: orgId,
    organization_name: membership.name,
    role: membership.role,
    server,
    session_expires_at: config.expires_at,
  };

  writeOutput(
    result,
    options,
    [
      `Server: ${server}`,
      `Organization: ${membership.name} (${orgId})`,
      `Role: ${membership.role}`,
      `Session expires: ${config.expires_at ?? "unknown"}`,
    ].join("\n"),
  );
  return result;
}

import { getClient, handleResponse } from "../api-client";
import type { FetchImplementation } from "../auth";
import { loadConfig, resolveServerUrl } from "../config";
import { CliError } from "../errors";
import { writeOutput, type OutputOptions } from "../output";

export interface WhoAmIDependencies {
  configPath?: string;
  fetchImpl?: FetchImplementation;
}

export interface WhoAmIResult {
  user_id: string;
  name: string;
  email: string;
  organization?: string;
  organization_name?: string;
  role?: string;
  server: string;
  session_expires_at?: string;
}

interface OrganizationMembership {
  id: string;
  name: string;
  role: string;
}

interface CurrentUser {
  id: string;
  name: string;
  email: string;
}

export async function whoami(
  options: OutputOptions & { org?: string } = {},
  dependencies: WhoAmIDependencies = {},
): Promise<WhoAmIResult> {
  const { config } = getClient(loadConfig(dependencies.configPath));
  const orgId = options.org?.trim() || config.org?.trim();
  const server = resolveServerUrl(config);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const request = {
    headers: { Authorization: `Bearer ${config.session_token}` },
  };
  const identity = await handleResponse<{ user: CurrentUser }>(
    await fetchImpl(`${server}/v1/me`, request),
  );
  let membership: OrganizationMembership | undefined;
  if (orgId) {
    const memberships = await handleResponse<{
      organizations: OrganizationMembership[];
    }>(await fetchImpl(`${server}/v1/orgs`, request));
    membership = memberships.organizations.find(({ id }) => id === orgId);
    if (!membership) {
      throw new CliError(`You are not a member of organization '${orgId}'.`);
    }
  }
  const result: WhoAmIResult = {
    user_id: identity.user.id,
    name: identity.user.name,
    email: identity.user.email,
    ...(orgId && membership
      ? {
          organization: orgId,
          organization_name: membership.name,
          role: membership.role,
        }
      : {}),
    server,
    session_expires_at: config.expires_at,
  };

  writeOutput(
    result,
    options,
    [
      `User: ${identity.user.name} <${identity.user.email}>`,
      `User ID: ${identity.user.id}`,
      `Server: ${server}`,
      ...(orgId && membership
        ? [
            `Organization: ${membership.name} (${orgId})`,
            `Role: ${membership.role}`,
          ]
        : ["Organization: none selected"]),
      `Session expires: ${config.expires_at ?? "unknown"}`,
    ].join("\n"),
  );
  return result;
}

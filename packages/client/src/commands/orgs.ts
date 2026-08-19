import type { Command } from "commander";

import {
  getClient,
  handleResponse,
  type ApiClient,
  type AuthenticatedClient,
  withErrorHandling,
} from "../api-client";
import { saveConfig, type ClientConfig } from "../config";
import { CliError } from "../errors";
import type { GlobalOptions } from "../index";
import { writeOutput } from "../output";

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  created_at: string;
}

interface OrganizationsApiClient {
  v1: {
    orgs: {
      $get(): Promise<Response>;
      $post(input: {
        json: { name: string; slug?: string };
      }): Promise<Response>;
    };
  };
}

export interface OrganizationCommandDependencies {
  getClient(): AuthenticatedClient;
  handleResponse: typeof handleResponse;
  saveConfig(config: ClientConfig): void;
  writeOutput: typeof writeOutput;
}

const defaultDependencies: OrganizationCommandDependencies = {
  getClient,
  handleResponse,
  saveConfig,
  writeOutput,
};

function organizationsApi(client: ApiClient): OrganizationsApiClient {
  return client as unknown as OrganizationsApiClient;
}

async function listOrganizations(
  dependencies: OrganizationCommandDependencies,
): Promise<{
  authenticated: AuthenticatedClient;
  organizations: OrganizationSummary[];
}> {
  const authenticated = dependencies.getClient();
  const response = await organizationsApi(authenticated.client).v1.orgs.$get();
  const result = await dependencies.handleResponse<{
    organizations: OrganizationSummary[];
  }>(response);
  return { authenticated, organizations: result.organizations };
}

export function registerOrganizationCommands(
  program: Command,
  dependencies: OrganizationCommandDependencies = defaultDependencies,
): void {
  const orgs = program
    .command("orgs")
    .alias("org")
    .description("List, create, and select organizations");

  orgs
    .command("list")
    .description("list organizations you belong to")
    .action(
      withErrorHandling(async (_options, command: Command) => {
        const options = command.optsWithGlobals<GlobalOptions>();
        const { authenticated, organizations } =
          await listOrganizations(dependencies);
        const human = organizations.length
          ? organizations
              .map((organization) => {
                const selected = authenticated.config.org === organization.id;
                return `${selected ? "*" : " "} ${organization.name} (${organization.id}) [${organization.role}]`;
              })
              .join("\n")
          : "No organizations. Create one with `saas orgs create <name>`.";
        dependencies.writeOutput({ organizations }, options, human);
      }),
    );

  orgs
    .command("create <name>")
    .description("create and select a new organization")
    .option("--slug <slug>", "URL-safe organization slug")
    .action(
      withErrorHandling(
        async (name: string, createOptions, command: Command) => {
          const options = command.optsWithGlobals<GlobalOptions>();
          const authenticated = dependencies.getClient();
          const response = await organizationsApi(
            authenticated.client,
          ).v1.orgs.$post({
            json: {
              name,
              ...(createOptions.slug ? { slug: createOptions.slug } : {}),
            },
          });
          const result = await dependencies.handleResponse<{
            organization: OrganizationSummary;
          }>(response);
          dependencies.saveConfig({
            ...authenticated.config,
            org: result.organization.id,
          });
          dependencies.writeOutput(
            result,
            options,
            `Created and selected organization: ${result.organization.name} (${result.organization.id})`,
          );
        },
      ),
    );

  orgs
    .command("use <org-id>")
    .description("select the default organization")
    .action(
      withErrorHandling(
        async (orgId: string, _useOptions, command: Command) => {
          const options = command.optsWithGlobals<GlobalOptions>();
          const { authenticated, organizations } =
            await listOrganizations(dependencies);
          const organization = organizations.find(({ id }) => id === orgId);
          if (!organization) {
            throw new CliError(
              `You are not a member of organization '${orgId}'.`,
            );
          }
          dependencies.saveConfig({
            ...authenticated.config,
            org: organization.id,
          });
          dependencies.writeOutput(
            { organization },
            options,
            `Selected organization: ${organization.name} (${organization.id})`,
          );
        },
      ),
    );
}

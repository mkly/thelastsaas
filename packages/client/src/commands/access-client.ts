import {
  getOrgClient,
  handleResponse,
  type ApiClient,
  type OrganizationClient,
} from "../api-client";
import type { GlobalOptions } from "../index";
import { writeOutput } from "../output";

export type AccessApiClient = ApiClient;

export interface AccessCommandDependencies {
  getOrgClient(
    options?: Pick<GlobalOptions, "org" | "token">,
  ): OrganizationClient;
  handleResponse: typeof handleResponse;
  writeOutput: typeof writeOutput;
}

export const defaultAccessCommandDependencies: AccessCommandDependencies = {
  getOrgClient,
  handleResponse,
  writeOutput,
};

export function getAccessApi(client: ApiClient): AccessApiClient {
  return client;
}

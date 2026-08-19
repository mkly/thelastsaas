import type { Schema } from "@lastsaas/shared";

import {
  getOrgClient,
  handleResponse,
  type ApiClient,
  type OrganizationClient,
} from "../api-client";
import type { GlobalOptions } from "../index";
import { writeOutput } from "../output";

type PathParams = { orgId: string; name?: string; id?: string };

interface CollectionRoutes {
  $get(input: { param: Pick<PathParams, "orgId"> }): Promise<Response>;
  $post(input: {
    param: Pick<PathParams, "orgId">;
    json: { name: string; schema: Schema; description: string };
  }): Promise<Response>;
  [":name"]: {
    $get(input: {
      param: Required<Pick<PathParams, "orgId" | "name">>;
    }): Promise<Response>;
    $delete(input: {
      param: Required<Pick<PathParams, "orgId" | "name">>;
      query: { confirm: "true" };
    }): Promise<Response>;
    schema: {
      $patch(input: {
        param: Required<Pick<PathParams, "orgId" | "name">>;
        json: Record<string, unknown>;
      }): Promise<Response>;
    };
    records: RecordRoutes;
  };
}

interface RecordRoutes {
  $post(input: {
    param: Required<Pick<PathParams, "orgId" | "name">>;
    json: { data: Record<string, unknown> };
  }): Promise<Response>;
  batch: {
    $post(input: {
      param: Required<Pick<PathParams, "orgId" | "name">>;
      json: { records: Record<string, unknown>[] };
    }): Promise<Response>;
  };
  query: {
    $post(input: {
      param: Required<Pick<PathParams, "orgId" | "name">>;
      json: Record<string, unknown>;
    }): Promise<Response>;
  };
  count: {
    $post(input: {
      param: Required<Pick<PathParams, "orgId" | "name">>;
      json: Record<string, unknown>;
    }): Promise<Response>;
  };
  aggregate: {
    $post(input: {
      param: Required<Pick<PathParams, "orgId" | "name">>;
      json: Record<string, unknown>;
    }): Promise<Response>;
  };
  [":id"]: {
    $get(input: {
      param: Required<Pick<PathParams, "orgId" | "name" | "id">>;
    }): Promise<Response>;
    $patch(input: {
      param: Required<Pick<PathParams, "orgId" | "name" | "id">>;
      json: { data: Record<string, unknown> };
    }): Promise<Response>;
    $delete(input: {
      param: Required<Pick<PathParams, "orgId" | "name" | "id">>;
    }): Promise<Response>;
  };
}

export interface DataApiClient {
  v1: {
    orgs: {
      [":orgId"]: {
        collections: CollectionRoutes;
      };
    };
  };
}

export interface DataCommandDependencies {
  getOrgClient(options?: Pick<GlobalOptions, "org">): OrganizationClient;
  handleResponse: typeof handleResponse;
  writeOutput: typeof writeOutput;
}

export const defaultDataCommandDependencies: DataCommandDependencies = {
  getOrgClient,
  handleResponse,
  writeOutput,
};

/**
 * The server assembles domain routers from a registry, which intentionally
 * erases Hono's route literals from ApiType. Keep the cast at this boundary so
 * command modules still describe and check every request they issue.
 */
export function getDataApi(client: ApiClient): DataApiClient {
  return client as unknown as DataApiClient;
}

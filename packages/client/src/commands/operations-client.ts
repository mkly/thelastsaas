import {
  getOrgClient,
  handleResponse,
  type ApiClient,
  type OrganizationClient,
} from "../api-client";
import type { GlobalOptions } from "../index";
import { writeOutput } from "../output";

type OrgParam = { orgId: string };
type IdParam = OrgParam & { id: string };

interface FileRoutes {
  $get(input: {
    param: OrgParam;
    query: { prefix?: string };
  }): Promise<Response>;
  $post(input: {
    param: OrgParam;
    form: { file: Blob; path?: string };
  }): Promise<Response>;
  [":id"]: {
    $get(input: { param: IdParam }): Promise<Response>;
    $delete(input: { param: IdParam }): Promise<Response>;
    content: {
      $get(input: { param: IdParam }): Promise<Response>;
    };
  };
}

interface NotificationRoutes {
  $get(input: {
    param: OrgParam;
    query: { unread?: "true" };
  }): Promise<Response>;
  queue: {
    $post(input: {
      param: OrgParam;
      json: Record<string, unknown>;
    }): Promise<Response>;
  };
  preferences: {
    $get(input: { param: OrgParam }): Promise<Response>;
    $patch(input: {
      param: OrgParam;
      json: Record<string, unknown>;
    }): Promise<Response>;
  };
  schedules: {
    $get(input: { param: OrgParam }): Promise<Response>;
    $post(input: {
      param: OrgParam;
      json: Record<string, unknown>;
    }): Promise<Response>;
    [":id"]: {
      $delete(input: { param: IdParam }): Promise<Response>;
    };
  };
  [":id"]: {
    $patch(input: {
      param: IdParam;
      json: { read: boolean };
    }): Promise<Response>;
    $delete(input: { param: IdParam }): Promise<Response>;
  };
}

interface SystemRoutes {
  stats: {
    $get(input: { param: OrgParam }): Promise<Response>;
  };
  ["audit-log"]: {
    $get(input: {
      param: OrgParam;
      query: {
        limit?: string;
        action?: string;
        resource_type?: string;
      };
    }): Promise<Response>;
  };
  export: {
    $post(input: { param: OrgParam }): Promise<Response>;
  };
  import: {
    $post(input: {
      param: OrgParam;
      json: Record<string, unknown>;
    }): Promise<Response>;
  };
}

export interface OperationsApiClient {
  v1: {
    orgs: {
      [":orgId"]: SystemRoutes & {
        files: FileRoutes;
        notifications: NotificationRoutes;
      };
    };
  };
}

export interface OperationsCommandDependencies {
  getOrgClient(options?: Pick<GlobalOptions, "org">): OrganizationClient;
  handleResponse: typeof handleResponse;
  writeOutput: typeof writeOutput;
}

export const defaultOperationsCommandDependencies: OperationsCommandDependencies =
  {
    getOrgClient,
    handleResponse,
    writeOutput,
  };

/**
 * Domain-router registration intentionally erases Hono's route literals from
 * ApiType. Keep the cast at this boundary so every operations request remains
 * checked without spreading casts through command actions.
 */
export function getOperationsApi(client: ApiClient): OperationsApiClient {
  return client as unknown as OperationsApiClient;
}

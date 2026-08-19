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
type MemberParam = OrgParam & { memberId: string };

type PolicyAction = "read" | "write" | "delete" | "manage" | "*";
type FilterAction = "read" | "write" | "delete";

interface PermissionsRoutes {
  $get(input: { param: OrgParam }): Promise<Response>;
  policies: {
    $post(input: {
      param: OrgParam;
      json: { subject: string; resource: string; action: PolicyAction };
    }): Promise<Response>;
    $delete(input: {
      param: OrgParam;
      json: { subject: string; resource: string; action: PolicyAction };
    }): Promise<Response>;
  };
  roles: {
    $post(input: {
      param: OrgParam;
      json: { user_id: string; role: string };
    }): Promise<Response>;
    $delete(input: {
      param: OrgParam;
      json: { user_id: string; role: string };
    }): Promise<Response>;
  };
  check: {
    $post(input: {
      param: OrgParam;
      json: { user_id: string; resource: string; action: PolicyAction };
    }): Promise<Response>;
  };
  "row-filters": {
    $get(input: {
      param: OrgParam;
      query: { collection?: string };
    }): Promise<Response>;
    $post(input: {
      param: OrgParam;
      json: {
        collection: string;
        role: string;
        action: FilterAction;
        condition: Record<string, unknown>;
      };
    }): Promise<Response>;
    [":id"]: {
      $delete(input: { param: IdParam }): Promise<Response>;
    };
  };
  "field-filters": {
    $get(input: {
      param: OrgParam;
      query: { collection?: string };
    }): Promise<Response>;
    $post(input: {
      param: OrgParam;
      json: {
        collection: string;
        role: string;
        action: FilterAction;
        readable_fields: string[];
        writable_fields: string[];
      };
    }): Promise<Response>;
    [":id"]: {
      $delete(input: { param: IdParam }): Promise<Response>;
    };
  };
}

interface InvitationRoutes {
  $get(input: { param: OrgParam }): Promise<Response>;
  $post(input: {
    param: OrgParam;
    json: { email: string; role: "admin" | "member" };
  }): Promise<Response>;
  accept: {
    $post(input: {
      param: OrgParam;
      json: { invitation_id: string };
    }): Promise<Response>;
  };
  cancel: {
    $post(input: {
      param: OrgParam;
      json: { invitation_id: string };
    }): Promise<Response>;
  };
}

interface MemberRoutes {
  $get(input: {
    param: OrgParam;
    query: {
      limit: string;
      offset: string;
      role?: string;
      q?: string;
    };
  }): Promise<Response>;
  [":memberId"]: {
    role: {
      $patch(input: {
        param: MemberParam;
        json: { role: "admin" | "member" };
      }): Promise<Response>;
    };
    $delete(input: { param: MemberParam }): Promise<Response>;
  };
}

export interface AccessApiClient {
  v1: {
    orgs: {
      [":orgId"]: {
        permissions: PermissionsRoutes;
        invitations: InvitationRoutes;
        members: MemberRoutes;
      };
    };
  };
}

export interface AccessCommandDependencies {
  getOrgClient(options?: Pick<GlobalOptions, "org">): OrganizationClient;
  handleResponse: typeof handleResponse;
  writeOutput: typeof writeOutput;
}

export const defaultAccessCommandDependencies: AccessCommandDependencies = {
  getOrgClient,
  handleResponse,
  writeOutput,
};

/**
 * Domain-router registration intentionally erases Hono's route literals from
 * ApiType. Describe the access-control routes here so command requests remain
 * checked without spreading casts through every action.
 */
export function getAccessApi(client: ApiClient): AccessApiClient {
  return client as unknown as AccessApiClient;
}

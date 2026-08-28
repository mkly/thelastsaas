import { describe, expect, test } from "bun:test";

import {
  getClient,
  getOrgClient,
  handleResponse,
  parseJson,
} from "./api-client";
import { ReauthenticationRequiredError } from "./errors";

describe("API client conventions", () => {
  test("attaches an explicit API token to CLI request paths", async () => {
    const originalFetch = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return Response.json({ status: "ok" });
    }) as typeof fetch;
    try {
      const { client } = getOrgClient(
        { org: "org_123", token: "lsk_explicit" },
        { server: "https://api.example.test" },
      );
      const requestClient = client as unknown as {
        v1: {
          orgs: {
            [":orgId"]: {
              permissions: {
                $get(input: { param: { orgId: string } }): Promise<Response>;
              };
            };
          };
        };
      };
      await requestClient.v1.orgs[":orgId"].permissions.$get({
        param: { orgId: "org_123" },
      });

      expect(request?.headers.get("authorization")).toBe("Bearer lsk_explicit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses SAAS_API_TOKEN before a stored session", () => {
    const authenticated = getClient(
      {
        server: "https://api.example.test",
        session_token: "stored-session",
      },
      {},
      { SAAS_API_TOKEN: "lsk_environment" },
    );

    expect(authenticated.authToken).toBe("lsk_environment");
  });

  test("returns successful response envelopes", async () => {
    const result = await handleResponse<{ status: "ok"; value: number }>(
      Response.json({ status: "ok", value: 42 }),
    );
    expect(result.value).toBe(42);
  });

  test("turns HTTP 401 into a clear re-authentication error", async () => {
    const response = Response.json({ status: "error" }, { status: 401 });
    await expect(handleResponse(response)).rejects.toBeInstanceOf(
      ReauthenticationRequiredError,
    );
    await expect(
      handleResponse(Response.json({}, { status: 401 })),
    ).rejects.toThrow("saas login");
  });

  test("uses server error-envelope messages", async () => {
    const response = Response.json(
      { status: "error", message: "collection not found" },
      { status: 404 },
    );
    await expect(handleResponse(response)).rejects.toThrow(
      "collection not found",
    );
  });

  test("labels invalid JSON arguments", () => {
    expect(() => parseJson("{", "--where")).toThrow(
      "--where must be valid JSON",
    );
  });
});

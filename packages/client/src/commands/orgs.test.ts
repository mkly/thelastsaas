import { describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

import type { ApiClient } from "../api-client";
import type { ClientConfig } from "../config";
import {
  registerOrganizationCommands,
  type OrganizationCommandDependencies,
  type OrganizationSummary,
} from "./orgs";

const organizations: OrganizationSummary[] = [
  {
    id: "org_acme",
    name: "Acme",
    slug: "acme",
    role: "admin",
    created_at: "2026-08-19T00:00:00.000Z",
  },
  {
    id: "org_joined",
    name: "Joined Org",
    slug: "joined-org",
    role: "member",
    created_at: "2026-08-20T00:00:00.000Z",
  },
];

function harness(initialOrg?: string) {
  const config: ClientConfig = {
    server: "https://saas.example",
    session_token: "better-auth-token",
    ...(initialOrg ? { org: initialOrg } : {}),
  };
  const get = mock().mockImplementation(async () =>
    Response.json({ status: "ok", organizations }),
  );
  const post = mock().mockResolvedValue(
    Response.json(
      { status: "ok", organization: organizations[0] },
      { status: 201 },
    ),
  );
  const saveConfig = mock<(config: ClientConfig) => void>();
  const writeOutput = mock();
  const dependencies: OrganizationCommandDependencies = {
    getClient: () => ({
      client: {
        v1: { orgs: { $get: get, $post: post } },
      } as unknown as ApiClient,
      config,
    }),
    handleResponse: async <T>(response: Response) =>
      (await response.json()) as T,
    saveConfig,
    writeOutput,
  };
  const program = new Command();
  program.exitOverride();
  program.option("--json");
  registerOrganizationCommands(program, dependencies);
  return { get, post, program, saveConfig, writeOutput };
}

describe("organization commands", () => {
  test("lists memberships and marks the selected organization", async () => {
    const { program, writeOutput } = harness("org_joined");

    await program.parseAsync(["orgs", "list"], { from: "user" });

    expect(writeOutput).toHaveBeenCalledWith(
      { organizations },
      expect.any(Object),
      "  Acme (org_acme) [admin]\n* Joined Org (org_joined) [member]",
    );
  });

  test("creates and selects an organization", async () => {
    const { post, program, saveConfig } = harness();

    await program.parseAsync(["orgs", "create", "Acme", "--slug", "acme"], {
      from: "user",
    });

    expect(post).toHaveBeenCalledWith({
      json: { name: "Acme", slug: "acme" },
    });
    expect(saveConfig).toHaveBeenCalledWith({
      server: "https://saas.example",
      session_token: "better-auth-token",
      org: "org_acme",
    });
  });

  test("selects only an organization the user belongs to", async () => {
    const { program, saveConfig } = harness();

    await program.parseAsync(["orgs", "use", "org_joined"], {
      from: "user",
    });
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ org: "org_joined" }),
    );

    expect(
      program.parseAsync(["orgs", "use", "org_missing"], { from: "user" }),
    ).rejects.toThrow("not a member");
  });
});

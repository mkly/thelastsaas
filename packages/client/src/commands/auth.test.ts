import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

import { saveConfig } from "../config";
import { registerAuthCommands } from "./auth";
import { logout } from "./logout";
import { whoami } from "./whoami";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("auth commands", () => {
  test("registers login, whoami, and logout", () => {
    const program = new Command();
    registerAuthCommands(program);

    expect(program.commands.map((command) => command.name())).toEqual([
      "login",
      "whoami",
      "logout",
    ]);
  });

  test("whoami authenticates membership without requiring organization stats", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lastsaas-whoami-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    saveConfig(
      {
        expires_at: "2026-05-01T00:00:00.000Z",
        org: "org_default",
        server: "https://saas.example",
        session_token: "better-auth-token",
      },
      configPath,
    );
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const authorizations: Array<string | null> = [];

    try {
      const result = await whoami(
        { json: true },
        {
          configPath,
          fetchImpl: async (input, init) => {
            authorizations.push(
              new Headers(init?.headers).get("authorization"),
            );
            if (String(input) === "https://saas.example/v1/me") {
              return Response.json({
                status: "ok",
                user: {
                  id: "user_123",
                  name: "Mike Lay",
                  email: "mike@example.com",
                },
              });
            }
            expect(String(input)).toBe("https://saas.example/v1/orgs");
            return Response.json({
              status: "ok",
              organizations: [
                { id: "org_default", name: "Origin", role: "member" },
              ],
            });
          },
        },
      );

      expect(authorizations).toEqual([
        "Bearer better-auth-token",
        "Bearer better-auth-token",
      ]);
      expect(result.user_id).toBe("user_123");
      expect(result.name).toBe("Mike Lay");
      expect(result.email).toBe("mike@example.com");
      expect(result.organization).toBe("org_default");
      expect(result.organization_name).toBe("Origin");
      expect(result.role).toBe("member");
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  test("whoami reports identity when no organization is selected", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lastsaas-whoami-no-org-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    saveConfig(
      {
        server: "https://saas.example",
        session_token: "better-auth-token",
      },
      configPath,
    );
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const requests: string[] = [];

    try {
      const result = await whoami(
        {},
        {
          configPath,
          fetchImpl: async (input) => {
            requests.push(String(input));
            return Response.json({
              status: "ok",
              user: {
                id: "user_456",
                name: "Tom Turkey",
                email: "tom@example.com",
              },
            });
          },
        },
      );

      expect(requests).toEqual(["https://saas.example/v1/me"]);
      expect(result).toEqual({
        user_id: "user_456",
        name: "Tom Turkey",
        email: "tom@example.com",
        server: "https://saas.example",
      });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Organization: none selected"),
      );
    } finally {
      log.mockRestore();
    }
  });

  test("logout removes the stored config", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lastsaas-logout-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    saveConfig({ server: "https://saas.example" }, configPath);
    const log = spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await logout({}, configPath);
      expect(existsSync(configPath)).toBe(false);
      expect(log).toHaveBeenCalledWith("Logged out.");
    } finally {
      log.mockRestore();
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearConfig,
  loadConfig,
  resolveOrgId,
  saveConfig,
  type ClientConfig,
} from "./config";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("client config", () => {
  test("round-trips config with private file permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "lastsaas-client-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "config.json");
    const config: ClientConfig = {
      org: "org_default",
      server: "https://saas.example",
      session_token: "better-auth-token",
    };

    saveConfig(config, path);

    expect(loadConfig(path)).toEqual(config);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    clearConfig(path);
    expect(loadConfig(path)).toBeNull();
  });

  test("prefers --org over the configured default", () => {
    const config: ClientConfig = {
      org: "org_default",
      server: "https://saas.example",
    };
    expect(resolveOrgId(config, "org_flag")).toBe("org_flag");
    expect(resolveOrgId(config)).toBe("org_default");
  });
});

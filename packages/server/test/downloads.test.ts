import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import type { AppConfig } from "../src/config";
import type { AppEnvironment } from "../src/env";
import { downloadsRouter } from "../src/routes/downloads";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(TEST_DIR, "../../../dist");
const SERVER_DIST_DIR = resolve(TEST_DIR, "../dist");
const TEST_PLATFORM = "linux-x64";
const TEST_ARTIFACT = "saas-linux-x64";
const TEST_CONTENT = "hello binary";

function createApp(config?: Partial<AppConfig>) {
  const app = new Hono<AppEnvironment>();
  if (config) {
    app.use("*", async (context, next) => {
      context.set("config", config as AppConfig);
      await next();
    });
  }
  app.route("/", downloadsRouter);
  return app;
}

// The routes read the real repo-root dist directory, which may already hold a
// developer's compiled binaries: move those aside for the test and restore them
// afterwards instead of deleting them.
const MANAGED_FILES = [
  resolve(DIST_DIR, TEST_ARTIFACT),
  resolve(DIST_DIR, "saas"),
  resolve(SERVER_DIST_DIR, TEST_ARTIFACT),
  resolve(SERVER_DIST_DIR, "saas"),
];

beforeEach(() => {
  mkdirSync(DIST_DIR, { recursive: true });
  for (const path of MANAGED_FILES) {
    if (existsSync(path)) renameSync(path, `${path}.review-backup`);
  }
});

afterEach(() => {
  for (const path of MANAGED_FILES) {
    rmSync(path, { force: true });
    const backup = `${path}.review-backup`;
    if (existsSync(backup)) renameSync(backup, path);
  }
});

describe("download routes", () => {
  test("serves an allow-listed binary from repo-root dist", async () => {
    writeFileSync(resolve(DIST_DIR, TEST_ARTIFACT), TEST_CONTENT);

    const response = await createApp().request(
      `http://localhost/dl/${TEST_PLATFORM}/saas`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-length")).toBe(
      String(TEST_CONTENT.length),
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="saas"',
    );
    expect(await response.text()).toBe(TEST_CONTENT);
  });

  test("uses repo-root dist even when cwd is packages/server", async () => {
    const originalCwd = process.cwd();
    mkdirSync(SERVER_DIST_DIR, { recursive: true });
    writeFileSync(resolve(SERVER_DIST_DIR, TEST_ARTIFACT), "wrong dist");
    writeFileSync(resolve(DIST_DIR, TEST_ARTIFACT), TEST_CONTENT);

    try {
      process.chdir(resolve(TEST_DIR, ".."));
      const response = await createApp().request(
        `http://localhost/dl/${TEST_PLATFORM}/saas`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(TEST_CONTENT);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("returns 404 for missing and unlisted binaries", async () => {
    for (const path of [
      `/dl/${TEST_PLATFORM}/saas`,
      "/dl/not-allowed/saas",
      `/dl/${TEST_PLATFORM}/not-allowed`,
    ]) {
      const response = await createApp().request(`http://localhost${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        status: "error",
        error: "NotFound",
      });
    }

    const oldUrl = await createApp().request(
      `http://localhost/dl/${TEST_ARTIFACT}`,
    );
    expect(oldUrl.status).toBe(404);
  });

  test("falls back to the generic build for the host platform", async () => {
    const platform =
      process.platform === "linux"
        ? process.arch === "x64"
          ? "linux-x64"
          : process.arch === "arm64"
            ? "linux-arm64"
            : null
        : process.platform === "darwin"
          ? process.arch === "x64"
            ? "darwin-x64"
            : process.arch === "arm64"
              ? "darwin-arm64"
              : null
          : process.platform === "win32" && process.arch === "x64"
            ? "windows-x64"
            : null;

    if (!platform) return;

    writeFileSync(resolve(DIST_DIR, "saas"), TEST_CONTENT);
    const download = platform === "windows-x64" ? "saas.exe" : "saas";
    const response = await createApp().request(
      `http://localhost/dl/${platform}/${download}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${download}"`,
    );
    expect(await response.text()).toBe(TEST_CONTENT);
  });

  test("returns an install script with the external server pre-seeded", async () => {
    const response = await createApp().request("http://internal/install.sh", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/x-shellscript; charset=utf-8",
    );
    const script = await response.text();
    expect(script).toContain(
      'SERVER="${LASTSAAS_SERVER:-https://example.com}"',
    );
    expect(script).toContain('INSTALL_DIR="${LASTSAAS_INSTALL_DIR:-}"');
    expect(script).toContain('URL="$SERVER/dl/$PLATFORM/saas"');
    expect(script).toContain("$SERVER/dl/windows-x64/saas.exe");
    expect(script).toContain('INSTALL_DIR="$HOME/.local/bin"');
    expect(script).toContain("Installing to $HOME/.local/bin by default.");
    expect(script).not.toContain('INSTALL_DIR="/usr/local/bin"');
    expect(script).toContain('"server": "$SERVER"');
  });

  test("prefers the configured server URL over forwarded headers", async () => {
    const response = await createApp({
      betterAuthUrl: "https://saas.example.org",
    }).request("http://internal/install.sh", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example.net",
      },
    });

    const script = await response.text();
    expect(script).toContain(
      'SERVER="${LASTSAAS_SERVER:-https://saas.example.org}"',
    );
    expect(script).not.toContain("attacker.example.net");
  });

  test("rejects a forwarded host carrying shell metacharacters", async () => {
    const response = await createApp().request("http://localhost/install.sh", {
      headers: { "x-forwarded-host": 'example.com";id;"' },
    });

    const script = await response.text();
    expect(script).not.toContain("id;");
    expect(script).toContain('SERVER="${LASTSAAS_SERVER:-http://localhost}"');
  });
});

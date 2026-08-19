import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import { downloadsRouter } from "../src/routes/downloads";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(TEST_DIR, "../../../dist");
const SERVER_DIST_DIR = resolve(TEST_DIR, "../dist");
const TEST_BINARY = "saas-linux-x64";
const TEST_CONTENT = "hello binary";

function createApp() {
  const app = new Hono();
  app.route("/", downloadsRouter);
  return app;
}

beforeEach(() => {
  mkdirSync(DIST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(resolve(DIST_DIR, TEST_BINARY), { force: true });
  rmSync(resolve(DIST_DIR, "saas"), { force: true });
  rmSync(resolve(SERVER_DIST_DIR, TEST_BINARY), { force: true });
  rmSync(resolve(SERVER_DIST_DIR, "saas"), { force: true });
});

describe("download routes", () => {
  test("serves an allow-listed binary from repo-root dist", async () => {
    writeFileSync(resolve(DIST_DIR, TEST_BINARY), TEST_CONTENT);

    const response = await createApp().request(
      `http://localhost/dl/${TEST_BINARY}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-length")).toBe(
      String(TEST_CONTENT.length),
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${TEST_BINARY}"`,
    );
    expect(await response.text()).toBe(TEST_CONTENT);
  });

  test("uses repo-root dist even when cwd is packages/server", async () => {
    const originalCwd = process.cwd();
    mkdirSync(SERVER_DIST_DIR, { recursive: true });
    writeFileSync(resolve(SERVER_DIST_DIR, TEST_BINARY), "wrong dist");
    writeFileSync(resolve(DIST_DIR, TEST_BINARY), TEST_CONTENT);

    try {
      process.chdir(resolve(TEST_DIR, ".."));
      const response = await createApp().request(
        `http://localhost/dl/${TEST_BINARY}`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(TEST_CONTENT);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("returns 404 for missing and unlisted binaries", async () => {
    for (const binary of [TEST_BINARY, "not-allowed"]) {
      const response = await createApp().request(
        `http://localhost/dl/${binary}`,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        status: "error",
        error: "NotFound",
      });
    }
  });

  test("falls back to the generic build for the host platform", async () => {
    const platformBinary =
      process.platform === "linux"
        ? process.arch === "x64"
          ? "saas-linux-x64"
          : process.arch === "arm64"
            ? "saas-linux-arm64"
            : null
        : process.platform === "darwin"
          ? process.arch === "x64"
            ? "saas-darwin-x64"
            : process.arch === "arm64"
              ? "saas-darwin-arm64"
              : null
          : process.platform === "win32" && process.arch === "x64"
            ? "saas-windows-x64.exe"
            : null;

    if (!platformBinary) return;

    writeFileSync(resolve(DIST_DIR, "saas"), TEST_CONTENT);
    const response = await createApp().request(
      `http://localhost/dl/${platformBinary}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${platformBinary}"`,
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
    expect(script).toContain("Installing to $HOME/.local/bin by default.");
    expect(script).toContain("Re-run with sudo for a system-wide install");
    expect(script).toContain('"server": "$SERVER"');
  });
});

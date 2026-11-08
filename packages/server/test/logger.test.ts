import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});

function emit(overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-logger-"));
  directories.push(directory);
  return Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `import { log } from ${JSON.stringify(new URL("../src/logger.ts", import.meta.url).pathname)};
       log.debug({ scope: "probe" }, "hidden");
       log.info({ scope: "probe" }, "first\\nsecond");
       log.error({ scope: "probe", err: new Error("test failure") }, "failed");`,
    ],
    {
      cwd: directory,
      env: { ...process.env, LOG_LEVEL: "", LOG_FILE: "", ...overrides },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function entries(output: Uint8Array | string) {
  return (
    typeof output === "string" ? output : new TextDecoder().decode(output)
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("default stdout is JSON lines, including under systemd, with structured errors", () => {
  const result = emit({ JOURNAL_STREAM: "1:1" });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.byteLength).toBe(0);
  const lines = entries(result.stdout);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({
    level: 30,
    scope: "probe",
    msg: "first\nsecond",
    time: expect.any(Number),
    pid: expect.any(Number),
    hostname: expect.any(String),
  });
  expect(lines[1]).toMatchObject({
    level: 50,
    msg: "failed",
    err: { type: "Error", message: "test failure", stack: expect.any(String) },
  });
});

test("file destination appends and honors LOG_LEVEL without duplicating stdout", () => {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-log-file-"));
  directories.push(directory);
  const path = join(directory, "server.log");
  writeFileSync(path, '{"existing":true}\n');
  const result = emit({ LOG_FILE: path, LOG_LEVEL: "error" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.byteLength).toBe(0);
  expect(result.stderr.byteLength).toBe(0);
  const lines = entries(readFileSync(path, "utf8"));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toEqual({ existing: true });
  expect(lines[1]).toMatchObject({ level: 50, scope: "probe", msg: "failed" });
});

test("silent suppresses output and an unavailable file fails visibly", () => {
  const silent = emit({ LOG_LEVEL: "silent" });
  expect(silent.exitCode).toBe(0);
  expect(silent.stdout.byteLength).toBe(0);
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-log-missing-"));
  directories.push(directory);
  const failed = emit({ LOG_FILE: join(directory, "missing", "server.log") });
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stderr.byteLength).toBeGreaterThan(0);
});

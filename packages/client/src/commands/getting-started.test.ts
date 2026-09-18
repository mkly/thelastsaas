import { expect, test } from "bun:test";
import { getGettingStartedGuide } from "@lastsaas/shared";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../index.ts", import.meta.url));

test("CLI prints the shared tutorial without a server or login", () => {
  const result = Bun.spawnSync(["bun", entry, "getting-started"], {
    env: { ...process.env, SAAS_API_TOKEN: "" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe(
    getGettingStartedGuide("cli").trim(),
  );
  expect(result.stderr.toString()).toBe("");
});

test("CLI tutorial supports JSON output with command-specific setup", () => {
  const result = Bun.spawnSync(["bun", entry, "--json", "getting-started"]);
  expect(result.exitCode).toBe(0);
  const { guide } = JSON.parse(result.stdout.toString());
  expect(guide).toBe(getGettingStartedGuide("cli"));
  expect(guide).toContain("saas orgs create");
  expect(guide).toContain("saas skills print");
  expect(guide).not.toContain("organizations_select");
});

import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const databaseUrl = process.env.TEST_POSTGRES_URL;
if (!databaseUrl || !/^postgres(ql)?:/.test(databaseUrl)) {
  throw new Error("Set TEST_POSTGRES_URL to a PostgreSQL test database URL");
}
// Every run gets a fresh schema. Do not push into the caller's existing schema.
const schema = `query_test_${crypto.randomUUID().replaceAll("-", "")}`;
const url = new URL(databaseUrl);
url.searchParams.set("schema", schema);
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  QUERY_TEST_DATABASE_URL: url.toString(),
};
const prisma = ["bun", "run", "--cwd", "packages/server", "prisma"];

async function run(cmd: string[], input?: string): Promise<void> {
  const process = Bun.spawn(cmd, {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: input === undefined ? "ignore" : new Blob([input]),
  });
  const code = await process.exited;
  if (code !== 0)
    throw new Error(`Command failed (${code}): ${cmd.slice(0, 5).join(" ")}`);
}

try {
  await run([
    "bun",
    "run",
    "--cwd",
    "packages/server",
    "prisma:generate:postgres",
  ]);
  await run([
    ...prisma,
    "db",
    "push",
    "--schema",
    "prisma/schema.postgres.prisma",
    "--skip-generate",
  ]);
  await run(["bun", "run", "--cwd", "packages/server", "typecheck"]);
  await run(["bun", "test", "packages/server/test/query-backends.test.ts"]);
} finally {
  try {
    await run(
      [
        ...prisma,
        "db",
        "execute",
        "--schema",
        "prisma/schema.postgres.prisma",
        "--stdin",
      ],
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
    );
  } finally {
    // The ordinary suite targets SQLite; leave the local client ready for it.
    await run(["bun", "run", "--cwd", "packages/server", "prisma:generate"]);
  }
}

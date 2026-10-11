import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const selection = process.argv[2];
if (selection && !["--queues", "--automation"].includes(selection))
  throw new Error("Usage: test-postgres.ts [--queues|--automation]");
const databaseUrl = process.env.TEST_POSTGRES_URL;
if (!databaseUrl || !/^postgres(ql)?:/.test(databaseUrl)) {
  throw new Error("Set TEST_POSTGRES_URL to a PostgreSQL test database URL");
}
const schema = `test_${crypto.randomUUID().replaceAll("-", "")}`;
const url = new URL(databaseUrl);
url.searchParams.set("schema", schema);
// Override every selected suite's datasource so inherited fixture URLs cannot
// redirect tests to another database. Run files sequentially: some use fixed IDs.
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  QUERY_TEST_DATABASE_URL: url.toString(),
  QUEUE_SERVICE_TEST_DATABASE_URL: url.toString(),
  TRANSACTION_TEST_DATABASE_URL: url.toString(),
  JOBS_TEST_DATABASE_URL: url.toString(),
  AUTOMATION_TEST_DATABASE_URL: url.toString(),
  SCHEDULE_TEST_DATABASE_URL: url.toString(),
  NOTIFICATION_OCCURRENCE_DATABASE_URL: url.toString(),
};
const prisma = ["packages/server/node_modules/.bin/prisma"];

async function run(cmd: string[], input?: string): Promise<void> {
  const child = Bun.spawn(cmd, {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: input === undefined ? "ignore" : new Blob([input]),
  });
  const code = await child.exited;
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
    "packages/server/prisma/schema.postgres.prisma",
    "--skip-generate",
  ]);
  await run(["bun", "run", "--cwd", "packages/server", "typecheck"]);
  const files =
    selection === "--queues"
      ? ["job-backends.test.ts", "queue-services.test.ts"]
      : [
          "job-backends.test.ts",
          "queue-services.test.ts",
          "transactions-service.test.ts",
          "schedules.test.ts",
          "automation-integration.test.ts",
          "schedule-materialize.test.ts",
          "notification-occurrences.test.ts",
        ];
  if (!selection)
    files.push("query-backends.test.ts", "notification-audiences.test.ts");
  for (const file of files) {
    await run(
      [
        ...prisma,
        "db",
        "execute",
        "--schema",
        "packages/server/prisma/schema.postgres.prisma",
        "--stdin",
      ],
      `TRUNCATE "${schema}".organization, "${schema}"."user", "${schema}".job_outbox CASCADE; DROP SCHEMA IF EXISTS "${schema}_jobs" CASCADE;`,
    );
    await run(["bun", "test", `packages/server/test/${file}`]);
  }
} finally {
  try {
    await run(
      [
        ...prisma,
        "db",
        "execute",
        "--schema",
        "packages/server/prisma/schema.postgres.prisma",
        "--stdin",
      ],
      `DROP SCHEMA IF EXISTS "${schema}_jobs" CASCADE; DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
    );
  } finally {
    await run(["bun", "run", "--cwd", "packages/server", "prisma:generate"]);
  }
}

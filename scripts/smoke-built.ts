import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ClaimResponse,
  JobListResponse,
  JobResponse,
  NotifyResponse,
  EnqueueResponse,
} from "@lastsaas/shared";

// Only public HTTP and the compiled CLI exercise the running server. Prisma
// below provisions/drops fixtures; no direct database seeding bypasses auth.
const root = resolve(import.meta.dir, "..");
const postgresUrl = process.env.TEST_POSTGRES_URL;
if (!postgresUrl || !/^postgres(ql)?:/.test(postgresUrl))
  throw new Error(
    "Set TEST_POSTGRES_URL to a disposable PostgreSQL test database",
  );
const fixture = mkdtempSync(join(tmpdir(), "lastsaas-built-smoke-"));
const configPath = join(homedir(), ".lastsaas/config.json");
const savedConfig = existsSync(configPath) ? readFileSync(configPath) : null;
const savedMode = savedConfig ? statSync(configPath).mode & 0o777 : 0o600;
const schema = `built_smoke_${crypto.randomUUID().replaceAll("-", "")}`;
const postgres = new URL(postgresUrl);
postgres.searchParams.set("schema", schema);
const prisma = "packages/server/node_modules/.bin/prisma";

async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  capture = false,
  input?: string,
): Promise<string> {
  const child = Bun.spawn(args, {
    cwd: root,
    env,
    stdout: capture ? "pipe" : "inherit",
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : new Blob([input]),
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      capture ? new Response(child.stdout).text() : Promise.resolve(""),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) {
      // CLI stderr may contain credentials; never echo it or the full argv.
      if (args[0] !== join(root, "dist/saas")) console.error(error);
      throw new Error(`${args[0]} ${args[1]} failed (${code})`);
    }
    return output;
  } finally {
    clearTimeout(timeout);
  }
}

async function sha256(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function smoke(provider: "sqlite" | "postgres"): Promise<void> {
  const databaseUrl =
    provider === "sqlite"
      ? `file:${join(fixture, "smoke.db")}`
      : postgres.toString();
  // Reserve a free port briefly so independent smoke runs do not share it.
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    PORT: String(port),
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    PASSWORD_AUTH_ENABLED: "true",
    SMTP_HOST: "",
    LOG_LEVEL: "info",
    STORAGE_TYPE: "local",
    STORAGE_PATH: join(fixture, provider),
    SAAS_API_TOKEN: "",
  };
  await run(
    [
      "bun",
      "run",
      "--cwd",
      "packages/server",
      provider === "sqlite" ? "prisma:generate" : "prisma:generate:postgres",
    ],
    env,
  );
  await run(
    provider === "sqlite"
      ? [
          prisma,
          "migrate",
          "deploy",
          "--schema",
          "packages/server/prisma/schema.prisma",
        ]
      : ["bun", "run", "--cwd", "packages/server", "prisma:push:postgres"],
    env,
  );
  await run(
    ["bun", "run", "scripts/build-server.ts", "--current-platform"],
    env,
  );

  const server = Bun.spawn([join(root, "dist/saas-server")], {
    cwd: fixture, // No source checkout, Prisma directory or dist beside server.
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let logs = "";
  async function drain(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    for await (const chunk of stream)
      logs += decoder.decode(chunk, { stream: true });
  }
  const drains = Promise.all([drain(server.stdout), drain(server.stderr)]);
  let running = true;
  void server.exited.then(() => {
    running = false;
  });
  async function waitFor(check: () => Promise<boolean>, label: string) {
    const deadline = Date.now() + 30_000;
    while (running && Date.now() < deadline) {
      if (await check()) return;
      await Bun.sleep(100);
    }
    // Retain no auth URLs/tokens from console email in diagnostics.
    throw new Error(`${provider}: ${label} failed; server running=${running}`);
  }
  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(new URL(path, origin), {
      ...init,
      signal: AbortSignal.timeout(5_000),
    });
    assert(
      response.ok,
      `${provider}: HTTP ${response.status} at ${path.split("?")[0]}`,
    );
    return response;
  }
  const cli = async <T>(...args: string[]): Promise<T> =>
    JSON.parse(
      await run([join(root, "dist/saas"), "--json", ...args], env, true),
    ) as T;
  try {
    await waitFor(async () => {
      try {
        return (
          await fetch(`${origin}/health`, {
            signal: AbortSignal.timeout(1_000),
          })
        ).ok;
      } catch {
        return false;
      }
    }, "health");
    console.log(`${provider}: compiled server GET /health passed`);
    const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
    const filename = process.platform === "win32" ? "saas.exe" : "saas";
    const download = await request(`/dl/${platform}/${filename}`);
    assert(download.body);
    assert.equal(
      await sha256(download.body),
      await sha256(Bun.file(join(root, "dist/saas")).stream()),
    );
    const excluded = platform === "darwin-x64" ? "linux-x64" : "darwin-x64";
    assert.equal(
      (
        await fetch(`${origin}/dl/${excluded}/saas`, {
          signal: AbortSignal.timeout(5_000),
        })
      ).status,
      404,
    );
    console.log(
      `${provider}: embedded host CLI download passed; excluded platform returns 404`,
    );
    const email = `${provider}@built-smoke.invalid`;
    const password = crypto.randomUUID();
    await request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password, name: "Built smoke" }),
    });
    let verificationUrl: string | undefined;
    await waitFor(async () => {
      verificationUrl = logs.match(
        /http:\/\/[^\s]+\/api\/auth\/verify-email\?[^\s]+/,
      )?.[0];
      return Boolean(verificationUrl);
    }, "console verification email");
    await request(verificationUrl!);
    const signedIn = await request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password }),
    });
    const token = signedIn.headers.get("set-auth-token");
    assert(token, "Sign-in must return a session token");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ server: origin, session_token: token }),
      { mode: 0o600 },
    );
    assert.equal((await cli<{ email: string }>("whoami")).email, email);
    const org = await cli<{ organization: { id: string } }>(
      "orgs",
      "create",
      "Built smoke",
    );
    const orgId = org.organization.id;
    await cli("queues", "create", "smoke", "--schema", '{"message":"string"}');
    const enqueued = await cli<EnqueueResponse>(
      "queues",
      "enqueue",
      "smoke",
      "--payload",
      '{"message":"built smoke"}',
    );
    assert.equal(enqueued.jobs.length, 1);
    const claimed = await cli<ClaimResponse>(
      "queues",
      "claim",
      "smoke",
      "--limit",
      "1",
    );
    assert.equal(claimed.claims.length, 1);
    const claim = claimed.claims[0]!;
    assert.equal(claim.job_id, enqueued.jobs[0]!.id);
    assert.deepEqual(claim.payload, { message: "built smoke" });
    const ack = await cli<JobResponse>(
      "queues",
      "ack",
      "smoke",
      claim.job_id,
      "--lease-token",
      claim.lease_token,
    );
    assert.equal(ack.job.state, "succeeded");
    const settled: JobListResponse = await (
      await request(`/v1/orgs/${orgId}/queues/smoke/jobs?state=succeeded`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    assert.equal(settled.items.length, 1);
    assert.equal(settled.items[0]!.id, claim.job_id);
    assert.equal(settled.items[0]!.state, "succeeded");
    assert.equal(settled.items[0]!.lease_expires_at, null);
    const notification = await cli<NotifyResponse>(
      "notify",
      "--subject",
      "Built notification",
      "--message",
      "Smoke check complete",
    );
    assert.equal(notification.kind, "immediate");
    if (notification.kind !== "immediate")
      throw new Error("Expected immediate notification");
    assert.equal(notification.queued_count, 1);
    const reminder = await cli<NotifyResponse>(
      "notify",
      "--subject",
      "Built reminder",
      "--at",
      "2030-01-01T09:00:00Z",
      "--dedupe-key",
      "built-reminder",
    );
    assert.equal(reminder.kind, "scheduled");
    if (reminder.kind !== "scheduled")
      throw new Error("Expected scheduled notification");
    assert.equal(reminder.schedule.subject, "Built reminder");
    await cli("notifications", "schedules", "cancel", reminder.schedule.id);
    console.log(
      `${provider}: compiled CLI whoami, org create, queue create, enqueue, claim, ack, notify, schedule cancellation and public API settled confirmation passed`,
    );
  } finally {
    server.kill("SIGTERM");
    const killTimer = setTimeout(() => server.kill("SIGKILL"), 5_000);
    await server.exited;
    clearTimeout(killTimer);
    await drains;
  }
}

try {
  await run(["bun", "run", "build:client"], process.env);
  await smoke("sqlite");
  await smoke("postgres");
} finally {
  try {
    await run(
      [prisma, "db", "execute", "--url", postgres.toString(), "--stdin"],
      { ...process.env, DATABASE_URL: postgres.toString() },
      false,
      `DROP SCHEMA IF EXISTS "${schema}_jobs" CASCADE; DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
    );
  } finally {
    if (savedConfig)
      writeFileSync(configPath, savedConfig, { mode: savedMode });
    else rmSync(configPath, { force: true });
    rmSync(fixture, { recursive: true, force: true });
    await run(
      ["bun", "run", "--cwd", "packages/server", "prisma:generate"],
      process.env,
    );
  }
}

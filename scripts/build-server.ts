import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const client = Bun.resolveSync("@prisma/client", join(root, "packages/server"));
const generatedClient = Bun.resolveSync(
  ".prisma/client/default",
  dirname(client),
);
const clientDir = dirname(generatedClient);
const engines = [...new Bun.Glob("libquery_engine-*.node").scanSync(clientDir)];
if (engines.length !== 1) {
  throw new Error(
    `Expected one generated Prisma query engine in ${clientDir}, found ${engines.length}`,
  );
}

// Resolve this at build time: deployed binaries do not need a Git checkout.
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: import.meta.dir,
  encoding: "utf8",
}).trim();
const build = { commit, builtAt: new Date().toISOString() };
const buildDir = mkdtempSync(join(tmpdir(), "lastsaas-server-build-"));
let exitCode: number;
try {
  const entrypoint = join(buildDir, "server.ts");
  // Prisma discovers its engine dynamically, so explicitly embed it and set
  // its path before importing the server or constructing a Prisma client.
  writeFileSync(
    entrypoint,
    `import engine from ${JSON.stringify(join(clientDir, engines[0]!))} with { type: "file" };
process.env.PRISMA_QUERY_ENGINE_LIBRARY = engine;
await import(${JSON.stringify(join(root, "packages/server/src/index.ts"))});
`,
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      entrypoint,
      "--compile",
      "--outfile",
      "dist/saas-server",
      "--define",
      `__SERVER_BUILD__=${JSON.stringify(build)}`,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  exitCode = result.exitCode;
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}
process.exit(exitCode);

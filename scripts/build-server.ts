import { execFileSync } from "node:child_process";

// Resolve this at build time: deployed binaries do not need a Git checkout.
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: import.meta.dir,
  encoding: "utf8",
}).trim();
const build = { commit, builtAt: new Date().toISOString() };
const result = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "packages/server/src/index.ts",
    "--compile",
    "--outfile",
    "dist/saas-server",
    "--define",
    `__SERVER_BUILD__=${JSON.stringify(build)}`,
  ],
  { cwd: `${import.meta.dir}/..`, stdout: "inherit", stderr: "inherit" },
);
process.exit(result.exitCode);

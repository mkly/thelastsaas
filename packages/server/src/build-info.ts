import { version as SERVER_VERSION } from "../package.json";
import { version as BUNDLED_CLI_VERSION } from "../../client/package.json";

declare const __SERVER_BUILD__: { commit: string; builtAt: string };

// Source runs have no embedded build; do not mistake runtime environment
// variables or a nearby Git checkout for the deployed binary's revision.
export const buildInfo = {
  version: SERVER_VERSION,
  bundledCliVersion: BUNDLED_CLI_VERSION,
  ...(typeof __SERVER_BUILD__ === "undefined"
    ? { commit: null, builtAt: null }
    : __SERVER_BUILD__),
  startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
};

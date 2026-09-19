declare const __SERVER_BUILD__: { commit: string; builtAt: string };

// Source runs have no embedded build; do not mistake runtime environment
// variables or a nearby Git checkout for the deployed binary's revision.
export const buildInfo = {
  ...(typeof __SERVER_BUILD__ === "undefined"
    ? { commit: null, builtAt: null }
    : __SERVER_BUILD__),
  startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
};

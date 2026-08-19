import { createApp } from "./app";
import { loadConfig } from "./config";
import { closeServices, createServices } from "./services";

const config = loadConfig();
const services = createServices(config);
const app = createApp({ config, services });

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: config.port,
  fetch: app.fetch,
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Shutting down...`);
  void server.stop().finally(async () => closeServices(services));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`Last SaaS server listening on ${server.url}`);

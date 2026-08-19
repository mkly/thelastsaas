import { createApp } from "./app";
import { loadConfig } from "./config";
import { closeServices, createServices } from "./services";

const config = loadConfig();
const services = await createServices(config);
const app = createApp({ config, services });

// Multipart framing is bounded separately by Busboy. This allowance keeps a
// file exactly at MAX_UPLOAD_SIZE from being rejected for its MIME headers.
export const MULTIPART_OVERHEAD_ALLOWANCE = 1024 * 1024;

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: config.port,
  maxRequestBodySize: config.maxUploadSize + MULTIPART_OVERHEAD_ALLOWANCE,
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

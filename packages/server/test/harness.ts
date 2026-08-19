import { createApp } from "../src/app";
import { closeServices, createServices } from "../src/services";

export function createTestApp() {
  const config = { port: 0, databaseUrl: "file::memory:" };
  const services = createServices(config);
  const app = createApp({ config, services });

  return {
    app,
    services,
    close: () => closeServices(services),
  };
}

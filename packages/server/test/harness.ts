import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { closeServices, createServices } from "../src/services";

export async function createTestApp() {
  const config = loadConfig({ PORT: "0", DATABASE_URL: "file::memory:" });
  const services = await createServices(config);
  const app = createApp({ config, services });

  return {
    app,
    services,
    close: () => closeServices(services),
  };
}

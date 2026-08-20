import type { AppConfig as Config } from "../config";
import type { AppServices as Services } from "../services";

export type McpToolContext = {
  services: Services;
  config: Config;
  orgId: string;
  userId: string;
};

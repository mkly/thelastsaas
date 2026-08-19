import type { AppConfig } from "./config";
import type { AppServices } from "./services";

export interface AppVariables {
  config: AppConfig;
  services: AppServices;
}

export interface AppEnvironment {
  Variables: AppVariables;
}

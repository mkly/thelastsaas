import type { AppConfig } from "./config";
import type { AuditWriter } from "./db/audit";
import type { AppServices } from "./services";

export interface AppVariables {
  config: AppConfig;
  services: AppServices;
  orgId: string;
  userId: string;
  audit: AuditWriter;
}

export interface AppEnvironment {
  Variables: AppVariables;
}

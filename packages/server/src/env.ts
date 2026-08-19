import type { AppConfig } from "./config";
import type { Where } from "@lastsaas/shared";
import type { AuditWriter } from "./db/audit";
import type { AppServices } from "./services";

export interface AppVariables {
  config: AppConfig;
  services: AppServices;
  orgId: string;
  userId: string;
  audit: AuditWriter;
  rowFilter: Where | null;
}

export interface AppEnvironment {
  Variables: AppVariables;
}

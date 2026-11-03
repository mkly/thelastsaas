import type { AppConfig } from "./config";
import type { AuditWriter } from "./db/audit";
import type { AppServices } from "./services";

import type { CollectionAccess } from "./db/collection-access";

export interface AppVariables {
  config: AppConfig;
  services: AppServices;
  orgId: string;
  userId: string;
  audit: AuditWriter;
  recordGrants: CollectionAccess;
}

export interface AppEnvironment {
  Variables: AppVariables;
}

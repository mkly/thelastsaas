import { Hono } from "hono";

import type { AppEnvironment } from "../env";
import { accountRouter } from "./account";
import { collectionsRouter } from "./collections";
import { fileRouter } from "./files";
import { healthRouter } from "./health";
import { invitationRouter } from "./invitations";
import { mcpRouter } from "./mcp";
import { memberRouter } from "./members";
import { notificationScheduleRouter } from "./notification-schedules";
import { notificationRouter } from "./notifications";
import { organizationRouter } from "./organizations";
import { permissionRouter } from "./permissions";
import { queueJobsRouter } from "./queue-jobs";
import { queuesRouter } from "./queues";
import { recordsRouter } from "./records";
import { recordHistoryRouter } from "./record-history";
import { serviceAccountRouter } from "./service-accounts";
import { secretsRouter } from "./secrets";
import { systemRouter } from "./system";
import { transactionsRouter } from "./transactions";
import { schedulesRouter } from "./schedules";
import { triggersRouter } from "./triggers";

export const apiRouter = new Hono<AppEnvironment>()
  .route("/health", healthRouter)
  .route("/v1", accountRouter)
  .route("/v1/orgs", organizationRouter)
  .route("/v1/orgs/:orgId/collections", collectionsRouter)
  .route("/v1/orgs/:orgId/collections/:name/records", recordsRouter)
  .route("/v1/orgs/:orgId/collections/:name", recordHistoryRouter)
  .route("/v1/orgs/:orgId/queues", queuesRouter)
  .route("/v1/orgs/:orgId/queues", queueJobsRouter)
  .route("/v1/orgs/:orgId/transactions", transactionsRouter)
  .route("/v1/orgs/:orgId/triggers", triggersRouter)
  .route("/v1/orgs/:orgId/schedules", schedulesRouter)
  .route("/v1/orgs/:orgId/secrets", secretsRouter)
  .route("/v1/orgs/:orgId/files", fileRouter)
  .route("/v1/orgs/:orgId/invitations", invitationRouter)
  .route("/v1/mcp", mcpRouter)
  .route("/v1/orgs/:orgId/members", memberRouter)
  .route("/v1/orgs/:orgId/service-accounts", serviceAccountRouter)
  .route("/v1/orgs/:orgId/notifications/schedules", notificationScheduleRouter)
  .route("/v1/orgs/:orgId/notifications", notificationRouter)
  .route("/v1/orgs/:orgId/permissions", permissionRouter)
  .route("/v1/orgs/:orgId", systemRouter);

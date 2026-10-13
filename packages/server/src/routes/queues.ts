import { jsonRequest, queryRequest } from "../lib/transport";
import {
  jobListSchema,
  pageRequestSchema,
  queueCreateSchema,
  queueUpdateSchema,
} from "@lastsaas/shared";
import { Hono, type Context } from "hono";
import type { AppEnvironment } from "../env";
import { createQueueConfigService } from "../queues/config";
import { createQueueReadService } from "../queues/read";
import { queueFailure, queuePrincipal } from "./queue-http";

function service(context: Context<AppEnvironment>) {
  const { prisma } = context.get("services");
  return {
    ...createQueueConfigService(prisma),
    ...createQueueReadService(prisma),
  };
}

/** Configuration and inspection only; producer/consumer routes are registered separately. */
export const queuesRouter = new Hono<AppEnvironment>()
  .post("/", jsonRequest(queueCreateSchema), async (context) => {
    try {
      const input = context.req.valid("json");
      const queue = await service(context).create(
        await queuePrincipal(context),
        input,
      );
      return context.json({ status: "ok" as const, queue }, 201);
    } catch (error) {
      return queueFailure(context, error);
    }
  })
  .get("/", queryRequest(pageRequestSchema), async (context) => {
    try {
      const page = await service(context).list(
        await queuePrincipal(context),
        context.req.valid("query"),
      );
      return context.json({ status: "ok" as const, ...page });
    } catch (error) {
      return queueFailure(context, error);
    }
  })
  .get("/:name", async (context) => {
    try {
      const queue = await service(context).show(
        await queuePrincipal(context),
        context.req.param("name"),
      );
      return context.json({ status: "ok" as const, queue });
    } catch (error) {
      return queueFailure(context, error);
    }
  })
  .patch("/:name", jsonRequest(queueUpdateSchema), async (context) => {
    try {
      const input = context.req.valid("json");
      const queue = await service(context).update(
        await queuePrincipal(context),
        context.req.param("name"),
        input,
      );
      return context.json({ status: "ok" as const, queue });
    } catch (error) {
      return queueFailure(context, error);
    }
  })
  .delete("/:name", async (context) => {
    try {
      await service(context).delete(
        await queuePrincipal(context),
        context.req.param("name"),
      );
      return context.json({ status: "ok" as const });
    } catch (error) {
      return queueFailure(context, error);
    }
  })
  .get("/:name/jobs", queryRequest(jobListSchema), async (context) => {
    try {
      const page = await service(context).listJobs(
        await queuePrincipal(context),
        context.req.param("name"),
        context.req.valid("query"),
      );
      return context.json({ status: "ok" as const, ...page });
    } catch (error) {
      return queueFailure(context, error);
    }
  });

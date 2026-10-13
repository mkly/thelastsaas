import { jsonRequest } from "../lib/transport";
import {
  ackRequestSchema,
  claimRequestSchema,
  jobActionSchema,
  enqueueRequestSchema,
  extendRequestSchema,
  nackRequestSchema,
} from "@lastsaas/shared";
import { Hono } from "hono";
import type { AppEnvironment } from "../env";
import { createQueueClaimService } from "../queues/claim";
import { createQueueEnqueueService } from "../queues/enqueue";
import { createQueueSettlementService } from "../queues/settle";
import { queueFailure, queuePrincipal } from "./queue-http";

/** Thin public adapters: the services own membership, grants and lease checks. */
export const queueJobsRouter = new Hono<AppEnvironment>()
  .post("/:name/jobs", jsonRequest(enqueueRequestSchema), async (context) => {
    try {
      const input = context.req.valid("json");
      const result = await createQueueEnqueueService(
        context.get("services").prisma,
      ).enqueue(
        await queuePrincipal(context),
        context.req.param("name"),
        input,
      );
      return context.json({ status: "ok" as const, ...result }, 201);
    } catch (error) {
      return queueFailure(context, error);
    }
  })
  .post("/:name/claim", jsonRequest(claimRequestSchema), async (context) => {
    try {
      const input = context.req.valid("json");
      const result = await createQueueClaimService(
        context.get("services").prisma,
      ).claim(await queuePrincipal(context), context.req.param("name"), input);
      return context.json({ status: "ok" as const, ...result });
    } catch (error) {
      return queueFailure(context, error);
    }
  })
  .post(
    "/:name/jobs/:id/ack",
    jsonRequest(ackRequestSchema),
    async (context) => {
      try {
        const input = context.req.valid("json");
        const job = await createQueueSettlementService(
          context.get("services").prisma,
        ).ack(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("id"),
          input,
        );
        return context.json({ status: "ok" as const, job });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .post(
    "/:name/jobs/:id/nack",
    jsonRequest(nackRequestSchema),
    async (context) => {
      try {
        const input = context.req.valid("json");
        const job = await createQueueSettlementService(
          context.get("services").prisma,
        ).nack(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("id"),
          input,
        );
        return context.json({ status: "ok" as const, job });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .post(
    "/:name/jobs/:id/extend",
    jsonRequest(extendRequestSchema),
    async (context) => {
      try {
        const input = context.req.valid("json");
        const job = await createQueueSettlementService(
          context.get("services").prisma,
        ).extend(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("id"),
          input,
        );
        return context.json({ status: "ok" as const, job });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .post(
    "/:name/jobs/:id/cancel",
    jsonRequest(jobActionSchema),
    async (context) => {
      try {
        const job = await createQueueSettlementService(
          context.get("services").prisma,
        ).cancel(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("id"),
        );
        return context.json({ status: "ok" as const, job });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .post(
    "/:name/jobs/:id/redrive",
    jsonRequest(jobActionSchema),
    async (context) => {
      try {
        const job = await createQueueSettlementService(
          context.get("services").prisma,
        ).redrive(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("id"),
        );
        return context.json({ status: "ok" as const, job });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  );

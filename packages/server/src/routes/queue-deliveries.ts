import { jsonRequest } from "../lib/transport";
import {
  ackRequestSchema,
  claimRequestSchema,
  deliveryActionSchema,
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
export const queueDeliveriesRouter = new Hono<AppEnvironment>()
  .post(
    "/:name/entries",
    jsonRequest(enqueueRequestSchema),
    async (context) => {
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
    },
  )
  .post(
    "/:name/subscriptions/:subscription/claim",
    jsonRequest(claimRequestSchema),
    async (context) => {
      try {
        const input = context.req.valid("json");
        const result = await createQueueClaimService(
          context.get("services").prisma,
        ).claim(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("subscription"),
          input,
        );
        return context.json({ status: "ok" as const, ...result });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .post(
    "/:name/deliveries/:id/ack",
    jsonRequest(ackRequestSchema),
    async (context) => {
      try {
        const input = context.req.valid("json");
        const delivery = await createQueueSettlementService(
          context.get("services").prisma,
        ).ack(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("id"),
          input,
        );
        return context.json({ status: "ok" as const, delivery });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .post(
    "/:name/deliveries/:id/nack",
    jsonRequest(nackRequestSchema),
    async (context) => {
      try {
        const input = context.req.valid("json");
        const delivery = await createQueueSettlementService(
          context.get("services").prisma,
        ).nack(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("id"),
          input,
        );
        return context.json({ status: "ok" as const, delivery });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .post(
    "/:name/deliveries/:id/extend",
    jsonRequest(extendRequestSchema),
    async (context) => {
      try {
        const input = context.req.valid("json");
        const delivery = await createQueueSettlementService(
          context.get("services").prisma,
        ).extend(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("id"),
          input,
        );
        return context.json({ status: "ok" as const, delivery });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .post(
    "/:name/deliveries/:id/cancel",
    jsonRequest(deliveryActionSchema),
    async (context) => {
      try {
        const delivery = await createQueueSettlementService(
          context.get("services").prisma,
        ).cancel(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("id"),
        );
        return context.json({ status: "ok" as const, delivery });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .post(
    "/:name/deliveries/:id/redrive",
    jsonRequest(deliveryActionSchema),
    async (context) => {
      try {
        const delivery = await createQueueSettlementService(
          context.get("services").prisma,
        ).redrive(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("id"),
        );
        return context.json({ status: "ok" as const, delivery });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  );

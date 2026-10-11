import { jsonRequest, queryRequest } from "../lib/transport";
import {
  deliveryListSchema,
  entryListSchema,
  pageRequestSchema,
  queueCreateSchema,
  queueUpdateSchema,
  subscriptionCreateSchema,
  subscriptionUpdateSchema,
} from "@lastsaas/shared";
import { Hono, type Context } from "hono";
import type { AppEnvironment } from "../env";
import { createQueueConfigService } from "../queues/config";
import { createQueueReadService } from "../queues/read";
import { createQueueSubscriptionService } from "../queues/subscriptions";
import { queueFailure, queuePrincipal } from "./queue-http";

function service(context: Context<AppEnvironment>) {
  const { prisma } = context.get("services");
  return {
    ...createQueueConfigService(prisma),
    ...createQueueSubscriptionService(prisma),
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
  .post(
    "/:name/subscriptions",
    jsonRequest(subscriptionCreateSchema),
    async (context) => {
      try {
        const input = context.req.valid("json");
        const subscription = await service(context).createSubscription(
          await queuePrincipal(context),
          context.req.param("name"),
          input,
        );
        return context.json({ status: "ok" as const, subscription }, 201);
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .get(
    "/:name/subscriptions",
    queryRequest(pageRequestSchema),
    async (context) => {
      try {
        const page = await service(context).listSubscriptions(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.valid("query"),
        );
        return context.json({ status: "ok" as const, ...page });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .patch(
    "/:name/subscriptions/:subscription",
    jsonRequest(subscriptionUpdateSchema),
    async (context) => {
      try {
        const input = context.req.valid("json");
        const subscription = await service(context).updateSubscription(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.param("subscription"),
          input,
        );
        return context.json({ status: "ok" as const, subscription });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  )
  .delete("/:name/subscriptions/:subscription", async (context) => {
    try {
      await service(context).deleteSubscription(
        await queuePrincipal(context),
        context.req.param("name"),
        context.req.param("subscription"),
      );
      return context.json({ status: "ok" as const });
    } catch (error) {
      return queueFailure(context, error);
    }
  })
  .get("/:name/entries", queryRequest(entryListSchema), async (context) => {
    try {
      const page = await service(context).listEntries(
        await queuePrincipal(context),
        context.req.param("name"),
        context.req.valid("query"),
      );
      return context.json({ status: "ok" as const, ...page });
    } catch (error) {
      return queueFailure(context, error);
    }
  })
  .get(
    "/:name/deliveries",
    queryRequest(deliveryListSchema),
    async (context) => {
      try {
        const page = await service(context).listDeliveries(
          await queuePrincipal(context),
          context.req.param("name"),
          context.req.valid("query"),
        );
        return context.json({ status: "ok" as const, ...page });
      } catch (error) {
        return queueFailure(context, error);
      }
    },
  );

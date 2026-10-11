import { jsonRequest, queryRequest } from "../lib/transport";
import {
  pageRequestSchema,
  triggerCreateSchema,
  triggerUpdateSchema,
} from "@lastsaas/shared";
import { Hono, type Context } from "hono";
import type { AppEnvironment } from "../env";
import { createTriggerService } from "../triggers/service";
import { triggerTransportError } from "../triggers/transport";

async function principal(context: Context<AppEnvironment>) {
  const userId = context.get("userId");
  const user = await context.get("services").prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return { orgId: context.get("orgId"), userId, userEmail: user?.email ?? "" };
}

function service(context: Context<AppEnvironment>) {
  return createTriggerService(context.get("services").prisma);
}

function failure(context: Context<AppEnvironment>, error: unknown) {
  const { body, status } = triggerTransportError(error);
  return context.json(body, status);
}

export const triggersRouter = new Hono<AppEnvironment>()
  .post("/", jsonRequest(triggerCreateSchema), async (context) => {
    try {
      const input = context.req.valid("json");
      const trigger = await service(context).create(
        await principal(context),
        input,
      );
      return context.json({ status: "ok" as const, trigger }, 201);
    } catch (error) {
      return failure(context, error);
    }
  })
  .get("/", queryRequest(pageRequestSchema), async (context) => {
    try {
      const input = context.req.valid("query");
      const page = await service(context).list(await principal(context), input);
      return context.json({ status: "ok" as const, ...page });
    } catch (error) {
      return failure(context, error);
    }
  })
  .get("/:id", async (context) => {
    try {
      const trigger = await service(context).show(
        await principal(context),
        context.req.param("id"),
      );
      return context.json({ status: "ok" as const, trigger });
    } catch (error) {
      return failure(context, error);
    }
  })
  .patch("/:id", jsonRequest(triggerUpdateSchema), async (context) => {
    try {
      const input = context.req.valid("json");
      const trigger = await service(context).update(
        await principal(context),
        context.req.param("id"),
        input,
      );
      return context.json({ status: "ok" as const, trigger });
    } catch (error) {
      return failure(context, error);
    }
  })
  .delete("/:id", async (context) => {
    try {
      await service(context).delete(
        await principal(context),
        context.req.param("id"),
      );
      return context.json({ status: "ok" as const });
    } catch (error) {
      return failure(context, error);
    }
  });

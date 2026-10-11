import { jsonRequest, queryRequest } from "../lib/transport";
import {
  pageRequestSchema,
  secretCreateSchema,
  secretReplaceSchema,
  secretRevealSchema,
  type AutomationContext,
} from "@lastsaas/shared";
import { Hono, type Context } from "hono";
import type { AppEnvironment } from "../env";
import { createSecretService } from "../secrets/service";
import { secretTransportError } from "../secrets/transport";

async function principal(
  context: Context<AppEnvironment>,
): Promise<AutomationContext> {
  const userId = context.get("userId");
  const user = await context.get("services").prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return { orgId: context.get("orgId"), userId, userEmail: user?.email ?? "" };
}

function service(context: Context<AppEnvironment>) {
  return createSecretService(
    context.get("services").prisma,
    context.get("config").secretKeyring,
  );
}

function failure(context: Context<AppEnvironment>, error: unknown) {
  const { body, status } = secretTransportError(error);
  return context.json(body, status);
}

export const secretsRouter = new Hono<AppEnvironment>()
  .post("/", jsonRequest(secretCreateSchema), async (context) => {
    try {
      const input = context.req.valid("json");
      const secret = await service(context).create(
        await principal(context),
        input,
      );
      return context.json({ status: "ok" as const, secret }, 201);
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
  .get("/:name", async (context) => {
    try {
      const secret = await service(context).show(
        await principal(context),
        context.req.param("name"),
      );
      return context.json({ status: "ok" as const, secret });
    } catch (error) {
      return failure(context, error);
    }
  })
  .patch("/:name", jsonRequest(secretReplaceSchema), async (context) => {
    try {
      const input = context.req.valid("json");
      const secret = await service(context).replace(
        await principal(context),
        context.req.param("name"),
        input,
      );
      return context.json({ status: "ok" as const, secret });
    } catch (error) {
      return failure(context, error);
    }
  })
  .delete("/:name", async (context) => {
    try {
      await service(context).delete(
        await principal(context),
        context.req.param("name"),
      );
      return context.json({ status: "ok" as const });
    } catch (error) {
      return failure(context, error);
    }
  })
  .post("/:name/reveal", jsonRequest(secretRevealSchema), async (context) => {
    try {
      const secret = await service(context).reveal(
        await principal(context),
        context.req.param("name"),
      );
      return context.json({ status: "ok" as const, secret });
    } catch (error) {
      return failure(context, error);
    }
  });

import { jsonRequest } from "../lib/transport";
import {
  AUTOMATION_LIMITS,
  errorResponse,
  transactionRequestSchema,
} from "@lastsaas/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnvironment } from "../env";
import { createTransactionService } from "../transactions/service";
import { transactionTransportError } from "../transactions/transport";

export const transactionsRouter = new Hono<AppEnvironment>()
  .use(
    "*",
    bodyLimit({
      maxSize: AUTOMATION_LIMITS.transactionBytes,
      onError: (c) =>
        c.json(
          errorResponse("RequestTooLarge", "Transaction request exceeds 1 MiB"),
          413,
        ),
    }),
  )
  .post("/", jsonRequest(transactionRequestSchema), async (context) => {
    try {
      const input = context.req.valid("json");
      const { prisma } = context.get("services");
      const userId = context.get("userId");
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      const result = await createTransactionService(prisma).execute(
        { orgId: context.get("orgId"), userId, userEmail: user?.email ?? "" },
        input,
      );
      return context.json({ status: "ok" as const, ...result });
    } catch (error) {
      const { body, status } = transactionTransportError(error);
      return context.json(body, status);
    }
  });

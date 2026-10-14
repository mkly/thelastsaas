import { Hono, type Context } from "hono";
import {
  recordHistoryQuerySchema,
  type RecordHistoryQuery,
} from "@lastsaas/shared";
import type { AppEnvironment } from "../env";
import { queryRecordHistory } from "../db/record-history";
import { queryRequest, transportError } from "../lib/transport";

async function history(
  context: Context<AppEnvironment>,
  input: RecordHistoryQuery,
) {
  try {
    const { prisma } = context.get("services");
    const userId = context.get("userId");
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const result = await queryRecordHistory(
      prisma,
      {
        orgId: context.get("orgId"),
        userId,
        userEmail: user?.email ?? "",
      },
      context.req.param("name")!,
      input,
    );
    return context.json({ status: "ok" as const, ...result });
  } catch (error) {
    const { body, status } = transportError(error);
    return context.json(body, status);
  }
}

export const recordHistoryRouter = new Hono<AppEnvironment>()
  .get("/history", queryRequest(recordHistoryQuerySchema), (context) =>
    history(context, context.req.valid("query")),
  )
  .get(
    "/records/:id/history",
    queryRequest(recordHistoryQuerySchema),
    (context) =>
      history(context, {
        ...context.req.valid("query"),
        record_id: context.req.param("id"),
      }),
  );

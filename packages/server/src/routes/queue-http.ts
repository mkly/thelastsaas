import { type AutomationContext } from "@lastsaas/shared";
import type { Context } from "hono";
import type { AppEnvironment } from "../env";
import { transportError } from "../lib/transport";

export async function queuePrincipal(
  context: Context<AppEnvironment>,
): Promise<AutomationContext> {
  const userId = context.get("userId");
  const user = await context.get("services").prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return { orgId: context.get("orgId"), userId, userEmail: user?.email ?? "" };
}

export function queueFailure(context: Context<AppEnvironment>, error: unknown) {
  const { body, status } = transportError(error);
  return context.json(body, status);
}

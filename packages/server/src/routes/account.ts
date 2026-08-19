import { errorResponse } from "@lastsaas/shared";
import { Hono } from "hono";

import type { AppEnvironment } from "../env";

export const accountRouter = new Hono<AppEnvironment>().get(
  "/me",
  async (context) => {
    const user = await context.get("services").prisma.user.findUnique({
      where: { id: context.get("userId") },
      select: { id: true, name: true, email: true },
    });
    if (!user) {
      return context.json(
        errorResponse("Unauthorized", "Authenticated user no longer exists"),
        401,
      );
    }
    return context.json({ status: "ok" as const, user });
  },
);

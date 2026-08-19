import { Hono } from "hono";

import type { AppEnvironment } from "../env";

export const healthRouter = new Hono<AppEnvironment>().get(
  "/",
  async (context) => {
    const { database, prisma } = context.get("services");
    if (database) database.query("SELECT 1").get();
    else await prisma.$queryRawUnsafe("SELECT 1");
    return context.json({ status: "ok" });
  },
);

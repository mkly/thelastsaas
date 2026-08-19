import { Hono } from "hono";

import type { AppEnvironment } from "../env";

export const healthRouter = new Hono<AppEnvironment>().get("/", (context) => {
  context.get("services").database.query("SELECT 1").get();
  return context.json({ status: "ok" });
});

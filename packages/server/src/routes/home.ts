import { Hono } from "hono";

import type { AppEnvironment } from "../env";

export const homeRouter = new Hono<AppEnvironment>();

homeRouter.get("/", async (context) => {
  const session = await context
    .get("services")
    .auth.api.getSession({ headers: context.req.raw.headers })
    .catch(() => null);
  return context.redirect(session?.user ? "/auth/dashboard" : "/auth/signup");
});

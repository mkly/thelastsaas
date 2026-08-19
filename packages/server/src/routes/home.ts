import { Hono } from "hono";

import type { AppEnvironment } from "../env";

export const homeRouter = new Hono<AppEnvironment>();

homeRouter.get("/", (context) =>
  context.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>The Last SaaS</title></head>
<body>
<h1>The Last SaaS</h1>
<p><a href="/auth/login">Login</a></p>
</body></html>`),
);

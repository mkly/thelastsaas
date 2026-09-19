import { Hono } from "hono";
import type { AppEnvironment } from "../env";
import { downloadLocalFile } from "../file-downloads";

export const fileDownloadsRouter = new Hono<AppEnvironment>().get(
  "/:id",
  (context) =>
    downloadLocalFile(
      context.get("services"),
      context.get("config"),
      context.req.param("id"),
      context.req.query("token") ?? "",
    ),
);

/**
 * The one static asset the pages load: the brand typeface.
 *
 * Everything else about the pages is inlined by `htmlPage()`, but a 43 KB
 * font would bloat every response and defeat the browser cache, so it is the
 * exception. The import embeds the file in standalone builds the same way the
 * CLI binaries are embedded in ./downloads; in source mode it resolves to the
 * file on disk. The URL carries no version because the font never changes —
 * if it ever does, rename the file and the URL together.
 */

import { Hono } from "hono";

import switzerPath from "../assets/Switzer-Variable.woff2" with { type: "file" };
import type { AppEnvironment } from "../env";

export const assetsRouter = new Hono<AppEnvironment>();

assetsRouter.get("/assets/switzer.woff2", () => {
  const font = Bun.file(switzerPath);
  return new Response(font.stream(), {
    headers: {
      "Content-Type": "font/woff2",
      "Content-Length": String(font.size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

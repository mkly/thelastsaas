/**
 * Public brand assets. File imports embed assets in standalone builds and
 * resolve to files on disk in source mode. Favicons retain alpha transparency
 * so favicon services can use the raster artwork without flattening an SVG.
 */

import { Hono } from "hono";

import switzerPath from "../assets/Switzer-Variable.woff2" with { type: "file" };
import faviconPath from "../assets/favicon.ico" with { type: "file" };
import faviconPngPath from "../assets/icon-96.png" with { type: "file" };
import type { AppEnvironment } from "../env";

export const assetsRouter = new Hono<AppEnvironment>();

for (const [url, path, contentType] of [
  ["/favicon.ico", faviconPath, "image/x-icon"],
  ["/icon-96.png", faviconPngPath, "image/png"],
] as const) {
  assetsRouter.get(url, () => {
    const icon = Bun.file(path);
    return new Response(icon.stream(), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(icon.size),
        "Cache-Control": "public, max-age=86400",
      },
    });
  });
}

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

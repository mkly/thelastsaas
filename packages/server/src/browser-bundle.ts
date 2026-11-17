/** Source runs build once on demand; standalone builds embed the same bundle. */
import { fileURLToPath } from "node:url";

declare global {
  var __LASTSAAS_AUTH_ASSET__: string | undefined;
}

export async function buildAuthBrowser(): Promise<Blob> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./browser/auth.ts", import.meta.url))],
    target: "browser",
    minify: true,
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Auth browser build failed");
  return result.outputs[0]!;
}

let bundle: Promise<Blob> | undefined;
export function authBrowserBundle(): Promise<Blob> {
  return (bundle ??= globalThis.__LASTSAAS_AUTH_ASSET__
    ? Promise.resolve(Bun.file(globalThis.__LASTSAAS_AUTH_ASSET__))
    : buildAuthBrowser());
}

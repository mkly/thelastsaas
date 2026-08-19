/** Shared helpers for the server-rendered authentication pages. */

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} - Last SaaS</title></head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
<hr>
<nav>
  <a href="/auth/login">Login</a> |
  <a href="/auth/signup">Sign Up</a> |
  <a href="/auth/magic-link">Magic Link</a> |
  <a href="/auth/forgot-password">Forgot Password</a>
</nav>
</body></html>`;
}

/**
 * The public origin to advertise in generated artifacts (install script, docs).
 *
 * The configured BETTER_AUTH_URL is authoritative — it is the same origin the
 * auth flows already use and is required in production. Request headers are
 * only a fallback (unit tests, unconfigured local runs) and are attacker
 * controlled, so the host is validated before it is used: the origin is
 * interpolated into a shell script, where a host containing quotes or `$(...)`
 * would otherwise become command substitution on the installing machine.
 */
export function getExternalOrigin(
  request: Request,
  configuredUrl?: string,
): string {
  const configuredOrigin = safeOrigin(configuredUrl);
  if (configuredOrigin) return configuredOrigin;

  const requestUrl = new URL(request.url);
  const forwardedProto = firstHeaderValue(request, "x-forwarded-proto");
  const forwardedHost = firstHeaderValue(request, "x-forwarded-host");
  const protocol = forwardedProto ?? requestUrl.protocol.replace(/:$/, "");
  const host = forwardedHost ?? request.headers.get("host") ?? requestUrl.host;

  return (
    safeOrigin(`${protocol}://${host}`) ??
    safeOrigin(requestUrl.origin) ??
    "http://localhost"
  );
}

/** A host is only accepted when it is a plain hostname/IP with optional port. */
const SAFE_HOST = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function safeOrigin(candidate: string | undefined): string | null {
  if (!candidate) return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!SAFE_HOST.test(url.host)) return null;
  return url.origin;
}

function firstHeaderValue(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.split(",")[0]?.trim();
  return value ? value : undefined;
}

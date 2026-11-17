import type { Context } from "hono";
import type { AppEnvironment } from "./env";
import { escapeHtml } from "./html";

export const oauthAuthorizePath = "/api/auth/oauth2/authorize";

export function signInPagePath(
  path: "/auth/login" | "/auth/signup",
  next?: string,
): string {
  if (!next) return path;
  // The OAuth client reads its signed request from the page's query string.
  if (next.startsWith(oauthAuthorizePath + "?")) {
    const search = next.slice(oauthAuthorizePath.length);
    const params = new URLSearchParams(search);
    if (params.has("client_id") && params.has("sig")) return path + search;
  }
  return path + "?" + new URLSearchParams({ next });
}

/** Presentation only. All authentication mutations go to Better Auth's HTTP API. */
export function authForm(
  context: Context<AppEnvironment>,
  action: string,
  body: string,
  next?: string,
): string {
  const protectedAction = [
    "magic-link",
    "login",
    "signup",
    "forgot-password",
  ].includes(action);
  const siteKey = protectedAction ? context.get("config").turnstileSiteKey : "";
  const retry =
    action === "google" ? signInPagePath("/auth/login", next) : undefined;
  return `<form method="post" data-auth="${escapeHtml(action)}" data-next="${escapeHtml(next ?? "/auth/dashboard")}"${retry ? ` data-error-callback="${escapeHtml(retry)}"` : ""}${siteKey ? ` data-captcha-site-key="${escapeHtml(siteKey)}"` : ""}>
    ${body.replace("<button ", `${siteKey ? "<div data-captcha></div>" : ""}<button `).replaceAll("<button ", "<button disabled ")}
    <p data-auth-message hidden aria-live="polite"></p>
    <noscript><p>Please enable JavaScript to continue.</p></noscript>
  </form>`;
}

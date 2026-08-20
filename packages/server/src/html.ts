/** Shared helpers for the server-rendered authentication pages. */

import { AsyncLocalStorage } from "node:async_hooks";

import { STYLESHEET } from "./styles";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface NavLink {
  readonly href: string;
  readonly label: string;
}

const SIGNED_IN_LINKS: ReadonlyArray<NavLink> = [
  { href: "/auth/dashboard", label: "Dashboard" },
  { href: "/auth/install", label: "Install CLI" },
  { href: "/auth/mcp", label: "MCP Server" },
];

const SIGNED_OUT_LINKS: ReadonlyArray<NavLink> = [
  { href: "/auth/login", label: "Log In" },
  { href: "/auth/signup", label: "Sign Up" },
  { href: "/auth/install", label: "Install CLI" },
];

/** An explicit override of the operating system's light/dark preference. */
export type Theme = "light" | "dark";

export const THEME_COOKIE = "theme";

export function parseTheme(value: string | undefined): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

interface PageContext {
  /** The reader's pinned theme, or null when they follow the system. */
  readonly theme: Theme | null;
  /** Path to return to after the theme switch posts. */
  readonly path: string;
}

/**
 * Per-request state that the layout needs but no route wants to think about.
 *
 * `htmlPage()` is a pure function called from twenty-odd handlers, and the
 * theme is not something any of them have an opinion on; threading it through
 * every signature would be a lot of plumbing for one attribute on <html>. The
 * middleware in `app.ts` reads the cookie once and runs the request inside this
 * store instead. Async-local storage rather than a module-level variable
 * because requests interleave at every await, and a shared mutable would hand
 * one reader another reader's theme.
 */
const pageStorage = new AsyncLocalStorage<PageContext>();

export function withPageContext<T>(
  theme: Theme | null,
  path: string,
  run: () => T,
): T {
  return pageStorage.run({ theme, path }, run);
}

export interface PageOptions {
  authenticated?: boolean;
  /** Path of the link to mark as the current page in the navigation. */
  current?: string;
  /** Narrow single-column layout, used by the auth and confirmation pages. */
  narrow?: boolean;
  /** Supporting sentence rendered under the page title. */
  description?: string;
}

function navLink(link: NavLink, current: string | undefined): string {
  const marker = link.href === current ? ` aria-current="page"` : "";
  return `<a href="${link.href}"${marker}>${escapeHtml(link.label)}</a>`;
}

/* Drawn inline so the pages ship no icon font and no sprite request. */
const ICON_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`;

/**
 * Log out, as an icon rather than a third nav link.
 *
 * It is the one item in the bar that ends the session rather than going
 * somewhere, and sitting in the row as a word of equal weight it read like a
 * destination. As an icon it keeps its place without competing with the two
 * links that are actually navigation. The label survives in aria-label and
 * title, so it is still announced and still nameable on hover.
 */
const LOGOUT_LINK = `<a class="icon-link" href="/auth/logout" aria-label="Log Out" title="Log Out">${ICON_OPEN}<path d="M15 16.5v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v2"/><path d="M19.5 12h-11m8-3.5 3.5 3.5-3.5 3.5"/></svg></a>`;

const THEME_OPTIONS: ReadonlyArray<{
  readonly value: "system" | Theme;
  readonly label: string;
  readonly icon: string;
}> = [
  {
    value: "system",
    label: "Follow the system theme",
    icon: `${ICON_OPEN}<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"/></svg>`,
  },
  {
    value: "light",
    label: "Light theme",
    icon: `${ICON_OPEN}<circle cx="12" cy="12" r="4.25"/><path d="M12 2.5v2M12 19.5v2M4.4 4.4l1.4 1.4M18.2 18.2l1.4 1.4M2.5 12h2M19.5 12h2M4.4 19.6l1.4-1.4M18.2 5.8l1.4-1.4"/></svg>`,
  },
  {
    value: "dark",
    label: "Dark theme",
    icon: `${ICON_OPEN}<path d="M20 14.4A8.5 8.5 0 0 1 9.6 4 8.5 8.5 0 1 0 20 14.4Z"/></svg>`,
  },
];

/**
 * The light/dark switch.
 *
 * A form post rather than a link, so the preference cannot be flipped by a
 * prefetch or by an <img> on somebody else's page, and so the `csrf()` guard on
 * the route has an origin to check. Three options rather than a toggle: with no
 * script the server cannot tell which way a toggle should flip while the reader
 * is still on the system default.
 */
function themeSwitch(theme: Theme | null, path: string): string {
  const options = THEME_OPTIONS.map((option) => {
    const pressed = (theme ?? "system") === option.value;
    return `<button class="theme__option" type="submit" name="theme" value="${option.value}" aria-pressed="${pressed}" aria-label="${option.label}" title="${option.label}">${option.icon}</button>`;
  }).join("");

  return `<form class="theme" method="post" action="/auth/theme">
      <input type="hidden" name="next" value="${escapeHtml(path)}">
      ${options}
    </form>`;
}

export function htmlPage(
  title: string,
  body: string,
  options: PageOptions = {},
): string {
  const links = options.authenticated ? SIGNED_IN_LINKS : SIGNED_OUT_LINKS;
  const navigation = links
    .map((link) => navLink(link, options.current))
    .join("");

  const description = options.description
    ? `<p class="lead">${escapeHtml(options.description)}</p>`
    : "";

  const page = pageStorage.getStore();
  const theme = page?.theme ?? null;
  const root = theme
    ? `<html lang="en" data-theme="${theme}">`
    : `<html lang="en">`;

  return `<!DOCTYPE html>
${root}<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='2' y='2' width='12' height='12' rx='3.5' fill='%23197c8c'/%3E%3C/svg%3E">
<link rel="preload" href="/assets/switzer.woff2" as="font" type="font/woff2" crossorigin>
<title>${escapeHtml(title)} - The Last SaaS</title>
<style>${STYLESHEET}</style>
</head>
<body class="shell">
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
  <div class="topbar__inner">
    <a class="brand" href="${options.authenticated ? "/auth/dashboard" : "/"}">
      <span class="brand__mark" aria-hidden="true"></span>
      <span>The Last SaaS</span>
    </a>
    <nav class="nav" aria-label="Main">${navigation}</nav>
    ${options.authenticated ? LOGOUT_LINK : ""}
    ${themeSwitch(theme, page?.path ?? "/")}
  </div>
</header>
<div class="scroll">
<main class="page${options.narrow ? " page--narrow" : ""}" id="main">
  <div class="page__header">
    <h1>${escapeHtml(title)}</h1>
    ${description}
  </div>
${body}
</main>
<footer class="footer">
  <div class="footer__inner">
    <span>The Last SaaS</span>
    <a href="/auth/install">Install CLI</a>
  </div>
</footer>
</div>
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

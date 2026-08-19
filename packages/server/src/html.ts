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

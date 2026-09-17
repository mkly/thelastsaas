import { Hono } from "hono";

import type { AppEnvironment } from "../env";
import { escapeHtml, htmlPage } from "../html";
import {
  claimServiceAccountToken,
  TokenClaimExpiredError,
  TokenClaimForbiddenError,
} from "../service-account-tokens";

export const tokenClaimRouter = new Hono<AppEnvironment>().get(
  "/tokens/claim/:code",
  async (context) => {
    const services = context.get("services");
    const session = await services.auth.api
      .getSession({ headers: context.req.raw.headers })
      .catch(() => null);
    if (!session?.user) {
      const next = encodeURIComponent(context.req.path);
      return context.redirect(`/auth/login?next=${next}`);
    }

    context.header("Cache-Control", "no-store, max-age=0");
    context.header("Referrer-Policy", "no-referrer");
    try {
      const claimed = await claimServiceAccountToken(
        services.prisma,
        context.req.param("code"),
        session.user.id,
      );
      return context.html(
        htmlPage(
          "Service account token",
          `<div class="card">
            <h2>Copy this token now</h2>
            <p>This secret is shown once. Store it securely before leaving this page.</p>
            <div class="token-claim">
              <button type="button" class="secondary" id="copy-token" aria-label="Copy token">Copy</button>
              <pre id="claimed-token"><code>${escapeHtml(claimed.token)}</code></pre>
            </div>
            <p id="copy-status" class="muted" role="status"></p>
          </div>
          <script>
            const copyButton = document.getElementById('copy-token');
            const tokenText = document.querySelector('#claimed-token code');
            const copyStatus = document.getElementById('copy-status');
            copyButton.addEventListener('click', async () => {
              copyButton.disabled = true;
              copyStatus.textContent = '';
              try {
                await navigator.clipboard.writeText(tokenText.textContent);
                copyStatus.textContent = 'Token copied.';
              } catch {
                copyStatus.textContent = 'Could not copy automatically. Select the token text and copy it manually.';
              } finally {
                copyButton.disabled = false;
              }
            });
          </script>`,
          { authenticated: true },
        ),
      );
    } catch (error) {
      if (error instanceof TokenClaimForbiddenError) {
        return context.html(
          htmlPage(
            "Claim forbidden",
            `<p class="alert alert--error" role="alert">${escapeHtml(error.message)}</p>`,
            { authenticated: true, narrow: true },
          ),
          403,
        );
      }
      const expired = error instanceof TokenClaimExpiredError;
      return context.html(
        htmlPage(
          expired ? "Claim expired" : "Claim unavailable",
          `<p class="alert alert--error" role="alert">${
            expired
              ? "This claim link has expired. Create a new service-account token."
              : "This claim link is invalid or has already been used."
          }</p>`,
          { authenticated: true, narrow: true },
        ),
        expired ? 410 : 404,
      );
    }
  },
);

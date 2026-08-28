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
            <pre><code>${escapeHtml(claimed.token)}</code></pre>
          </div>`,
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

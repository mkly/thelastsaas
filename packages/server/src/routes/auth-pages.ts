import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";

import type { AppEnvironment } from "../env";
import { authForm, oauthAuthorizePath, signInPagePath } from "../auth-ui";
import { THEME_COOKIE, escapeHtml, htmlPage, parseTheme } from "../html";
import {
  createOrganizationForUser,
  createOrganizationSchema,
  OrganizationSlugExistsError,
} from "../organizations";

export const authPagesRouter = new Hono<AppEnvironment>();

// Password recovery pages follow the same feature flag as Better Auth.
authPagesRouter.use("*", async (context, next) => {
  if (
    !context.get("config").passwordAuthEnabled &&
    context.req.method === "GET" &&
    ["/auth/forgot-password", "/auth/reset-password"].includes(context.req.path)
  ) {
    return context.redirect(
      authPath("/auth/login", { next: authNext(context) }),
    );
  }
  await next();
});

/**
 * Records the reader's light/dark choice and returns them to the page they were
 * on. Anything other than "light" or "dark" — including the "system" option —
 * clears the cookie and hands the decision back to the operating system.
 */
authPagesRouter.post("/theme", csrf(), async (context) => {
  const form = await context.req.parseBody();
  const theme = parseTheme(String(form["theme"] ?? ""));

  if (theme) {
    setCookie(context, THEME_COOKIE, theme, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(context.req.url).protocol === "https:",
    });
  } else {
    deleteCookie(context, THEME_COOKIE, { path: "/" });
  }

  return context.redirect(sameSitePath(String(form["next"] ?? "")), 303);
});

/** Only a site-relative path is honoured, so the switch is not a redirector. */
function sameSitePath(candidate: string): string {
  return /^\/(?![/\\])[^\\\s]*$/.test(candidate) ? candidate : "/";
}

function messageBanner(context: Context<AppEnvironment>): string {
  const error = context.req.query("error");
  const message = context.req.query("message");
  if (error)
    return `<p class="alert alert--error" role="alert">${escapeHtml(error)}</p>`;
  if (message)
    return `<p class="alert alert--success" role="status">${escapeHtml(message)}</p>`;
  return "";
}

function authNext(context: Context<AppEnvironment>): string | undefined {
  const next = context.req.query("next");
  return next &&
    sameSitePath(next) === next &&
    (next.startsWith("/auth/") ||
      next.startsWith("/tokens/claim/") ||
      next.startsWith(oauthAuthorizePath + "?"))
    ? next
    : undefined;
}

function signedOAuthParams(context: Context<AppEnvironment>): URLSearchParams {
  const parameters = new URL(context.req.url).searchParams;
  const signedNames = new Set([
    "sig",
    "ba_param",
    ...parameters.getAll("ba_param"),
  ]);
  return new URLSearchParams(
    [...parameters].filter(([key]) => signedNames.has(key)),
  );
}

function oauthContinuation(
  context: Context<AppEnvironment>,
): string | undefined {
  const signed = signedOAuthParams(context);
  return signed.has("sig") && signed.has("client_id")
    ? `${oauthAuthorizePath}?${signed}`
    : undefined;
}

function authPath(
  path: string,
  parameters: Record<string, string | undefined>,
): string {
  const url = new URL(path, "http://lastsaas.local");
  for (const [key, value] of Object.entries(parameters)) {
    if (value) url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}`;
}

async function isAuthenticated(
  context: Context<AppEnvironment>,
): Promise<boolean> {
  const session = await context
    .get("services")
    .auth.api.getSession({ headers: context.req.raw.headers })
    .catch(() => null);
  return Boolean(session?.user);
}

function googleForm(context: Context<AppEnvironment>, next?: string): string {
  const { googleClientId, googleClientSecret } = context.get("config");
  return googleClientId && googleClientSecret
    ? authForm(
        context,
        "google",
        '<button class="secondary" type="submit">Continue with Google</button>',
        next,
      )
    : "";
}

function emailField(email = ""): string {
  return `<label>Email<br><input type="email" name="email" required autocomplete="email" value="${escapeHtml(email)}"></label><br><br>`;
}

function magicForm(
  context: Context<AppEnvironment>,
  next?: string,
  email = "",
  introduction = "",
): string {
  if (next?.startsWith(oauthAuthorizePath + "?")) {
    const query = new URLSearchParams(next.slice(oauthAuthorizePath.length));
    // An emailed link resumes at authorize. These parameters require another
    // login on every visit, even immediately after email verification.
    if (
      query.get("prompt")?.split(" ").includes("login") ||
      (query.has("max_age") && Number(query.get("max_age")) === 0)
    ) {
      const config = context.get("config");
      const hasAlternative =
        config.passwordAuthEnabled ||
        Boolean(config.googleClientId && config.googleClientSecret);
      return hasAlternative
        ? "<p>This client requires a fresh sign-in. Use another sign-in method on this page.</p>"
        : "<p>This client requires a fresh sign-in. Contact the site administrator to enable Google or password sign-in for this connection.</p>";
    }
  }
  return (
    introduction +
    authForm(
      context,
      "magic-link",
      `${emailField(email)}<button type="submit">Continue with email</button>`,
      next,
    )
  );
}

authPagesRouter.get("/login", async (context) => {
  const oauth = oauthContinuation(context);
  const next = oauth ?? authNext(context);
  if (!oauth && (await isAuthenticated(context)))
    return context.redirect(next ?? "/auth/dashboard");
  const { passwordAuthEnabled } = context.get("config");
  const passwordForm = passwordAuthEnabled
    ? `<div class="card card--auth">${authForm(
        context,
        "login",
        `${emailField()}
        <label>Password<br><input type="password" name="password" required autocomplete="current-password"></label><br><br>
        <button type="submit">Log In</button>`,
        next,
      )}</div>`
    : "";
  return context.html(
    htmlPage(
      "Log In",
      `${messageBanner(context)}
    ${passwordForm}
    <div class="card card--auth">${magicForm(context, next)}</div>
    ${googleForm(context, next)}
    <p class="small muted" style="margin-block-start:1.25rem;text-align:center">
      Don't have an account? <a href="${escapeHtml(signInPagePath("/auth/signup", next))}">Sign up</a>
      ${passwordAuthEnabled ? ' · <a href="/auth/forgot-password">Forgot password?</a>' : ""}
    </p>`,
      { narrow: true, description: "Sign in to The Last SaaS." },
    ),
  );
});

authPagesRouter.get("/signup", async (context) => {
  const oauth = oauthContinuation(context);
  const next = oauth ?? authNext(context);
  if (!oauth && (await isAuthenticated(context)))
    return context.redirect(next ?? "/auth/dashboard");
  const email = context.req.query("email") ?? "";
  const { passwordAuthEnabled } = context.get("config");
  const form = passwordAuthEnabled
    ? authForm(
        context,
        "signup",
        `
        <label>Name<br><input type="text" name="name" required autocomplete="name"></label><br><br>
        ${emailField(email)}
        <label>Password<br><input type="password" name="password" required minlength="8" autocomplete="new-password"></label><br><br>
        <button type="submit">Create Account</button>`,
        next,
      )
    : magicForm(
        context,
        next,
        email,
        "<p>Enter your email to create an account.</p>",
      );
  return context.html(
    htmlPage(
      "Sign Up",
      `${messageBanner(context)}
    <div class="card card--auth">${form}</div>
    ${googleForm(context, next)}
    <p class="small muted" style="margin-block-start:1.25rem;text-align:center">
      Already have an account? <a href="${escapeHtml(signInPagePath("/auth/login", next))}">Log in</a>
    </p>`,
      { narrow: true, description: "Create your account." },
    ),
  );
});

authPagesRouter.get("/magic-link", (context) =>
  context.html(
    htmlPage(
      "Magic Link",
      `${messageBanner(context)}<div class="card card--auth">${magicForm(context, authNext(context))}</div>`,
      {
        narrow: true,
        description: "We'll email you a link that signs you in.",
      },
    ),
  ),
);

authPagesRouter.get("/forgot-password", (context) =>
  context.html(
    htmlPage(
      "Forgot Password",
      `${messageBanner(context)}
    <div class="card card--auth">${authForm(context, "forgot-password", `${emailField()}<button type="submit">Send Reset Link</button>`)}</div>
    <p class="small muted" style="margin-block-start:1.25rem;text-align:center"><a href="/auth/login">Back to log in</a></p>`,
      {
        narrow: true,
        description: "Enter your email and we'll send a reset link.",
      },
    ),
  ),
);

authPagesRouter.get("/reset-password", (context) =>
  context.html(
    htmlPage(
      "Reset Password",
      `${messageBanner(context)}<div class="card">${authForm(
        context,
        "reset-password",
        `
    <input type="hidden" name="token" value="${escapeHtml(context.req.query("token") ?? "")}">
    <label>New Password<br><input type="password" name="newPassword" required minlength="8" autocomplete="new-password"></label><br><br>
    <button type="submit">Reset Password</button>`,
      )}</div>`,
      {
        narrow: true,
        description: "Choose a new password of at least 8 characters.",
      },
    ),
  ),
);

authPagesRouter.get("/dashboard", async (context) => {
  const { auth, prisma } = context.get("services");
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session?.user) return context.redirect("/auth/login");
  const memberships = await prisma.member.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
  });
  const organizations = memberships.length
    ? `<ul class="record-list">${memberships
        .map(
          ({ organization, role }) =>
            `<li class="record">
              <div class="record__body">
                <div class="record__title">${escapeHtml(organization.name)}</div>
                <div class="record__meta">${escapeHtml(organization.slug)}</div>
              </div>
              <span class="badge">${escapeHtml(role)}</span>
            </li>`,
        )
        .join("")}</ul>`
    : `<div class="empty">
        <h3>No organizations yet</h3>
        <p>Create your first organization below, or accept an invitation from an existing one.</p>
      </div>`;
  const createOrganizationForm = memberships.length
    ? ""
    : `<h2>Create an organization</h2>
    <form method="POST" action="/auth/dashboard/organizations" class="form--narrow">
      <label>Name<input type="text" name="name" id="organization-name" required maxlength="100" autocomplete="organization"></label>
      <label>
        Slug
        <input type="text" name="slug" id="organization-slug" maxlength="64" pattern="[a-z0-9]+(?:-[a-z0-9]+)*">
        <span class="hint">Used in URLs.</span>
      </label>
      <button type="submit">Create Organization</button>
    </form>
    <script>
      // Previews the slug the server would generate (organizations.ts,
      // slugifyOrganizationName) while the slug field is untouched; typing in
      // the field takes it over, clearing it hands it back.
      {
        const name = document.getElementById("organization-name");
        const slug = document.getElementById("organization-slug");
        let edited = false;
        slug.addEventListener("input", () => {
          edited = slug.value !== "";
        });
        name.addEventListener("input", () => {
          if (edited) return;
          slug.value = name.value
            .normalize("NFKD")
            .replace(/[\\u0300-\\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 64);
        });
      }
    </script>`;

  return context.html(
    htmlPage(
      "Dashboard",
      `${messageBanner(context)}
    <div class="identity">
      <span class="identity__avatar" aria-hidden="true">${escapeHtml(initial(session.user.name, session.user.email))}</span>
      <div>
        <div class="identity__name">${escapeHtml(session.user.name)}</div>
        <div class="identity__detail">${escapeHtml(session.user.email)}</div>
      </div>
    </div>

    <h2>Organizations</h2>
    ${organizations}
    ${createOrganizationForm}
    `,
      {
        authenticated: true,
        current: "/auth/dashboard",
      },
    ),
  );
});

authPagesRouter.post("/dashboard/organizations", csrf(), async (context) => {
  const services = context.get("services");
  const session = await services.auth.api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session?.user) return context.redirect("/auth/login");

  const form = await context.req.parseBody();
  const slug = String(form.slug ?? "").trim();
  const parsed = createOrganizationSchema.safeParse({
    name: String(form.name ?? ""),
    slug: slug || undefined,
  });
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return context.redirect(authPath("/auth/dashboard", { error }), 303);
  }

  try {
    const organization = await createOrganizationForUser(
      services,
      session.user.id,
      parsed.data,
    );
    // A first organization means a brand-new workspace: send the user
    // straight to connecting a client instead of back to the dashboard.
    const memberships = await services.prisma.member.count({
      where: { userId: session.user.id },
    });
    if (memberships === 1) {
      return context.redirect(
        authPath("/install", {
          message: `${organization.name} created. Next, connect your assistant.`,
        }),
        303,
      );
    }
    return context.redirect(
      authPath("/auth/dashboard", {
        message: `${organization.name} created.`,
      }),
      303,
    );
  } catch (error) {
    if (error instanceof OrganizationSlugExistsError) {
      return context.redirect(
        authPath("/auth/dashboard", { error: error.message }),
        303,
      );
    }
    throw error;
  }
});

function initial(name: string, email: string): string {
  return (name.trim() || email).charAt(0);
}

authPagesRouter.get("/mcp/consent", async (context) => {
  const { auth } = context.get("services");
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session?.user) return context.redirect("/auth/login");
  const query = signedOAuthParams(context);
  const { secret } = await auth.$context;
  const client = (await verifyOAuthQueryParams(query.toString(), secret))
    ? await auth.api
        .getOAuthClientPublic({
          query: { client_id: query.get("client_id") ?? "" },
          headers: context.req.raw.headers,
        })
        .catch(() => null)
    : null;
  if (!client) {
    return context.html(
      htmlPage(
        "Authorize Connection",
        '<p class="alert alert--error">This authorization request is invalid or has expired. Restart the connection from your MCP client.</p>',
        { authenticated: true, narrow: true },
      ),
      400,
    );
  }
  const clientName = client.client_name || "MCP client";
  const redirect = new URL(query.get("redirect_uri")!);
  const scopes = (query.get("scope") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
    .join("");

  return context.html(
    htmlPage(
      "Authorize Connection",
      `<div class="card">
        <p><strong>${escapeHtml(clientName)}</strong> is requesting access to your Last SaaS account.</p>
        <p>After approval, you’ll return to <strong>${escapeHtml(redirect.host || redirect.protocol)}</strong>.</p>
        <p class="small muted">Requested access:</p>
        <ul>${scopes}</ul>
        <p>The client will be able to list and create organizations, select an active organization, and use Last SaaS tools with your existing permissions.</p>
      </div>
      ${authForm(
        context,
        "consent",
        `<div class="button-row">
          <button type="submit" name="decision" value="allow">Allow access</button>
          <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
        </div>
      `,
      )}`,
      {
        authenticated: true,
        narrow: true,
        description:
          "Review this request before sharing access to your account.",
      },
    ),
  );
});

authPagesRouter.get("/device", async (context) => {
  const userCode = context.req.query("user_code") ?? "";
  const next = authPath("/auth/device", { user_code: userCode });
  if (!(await isAuthenticated(context))) {
    return context.redirect(authPath("/auth/login", { next }));
  }

  if (!userCode) {
    return context.html(
      htmlPage("Authorize Device", "<p>The device code is missing.</p>"),
      400,
    );
  }

  try {
    // Device-code lookup has its own guessing limit. Keep the HTTP checks even
    // for this server-rendered read; approval and denial use the browser client.
    const response = await context.get("services").auth.handler(
      new Request(
        new URL(
          `/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
          context.get("config").betterAuthUrl,
        ),
        {
          headers: context.req.raw.headers,
        },
      ),
    );
    if (response.status === 429) {
      return context.text(
        "Too many device checks. Please try again later.",
        429,
      );
    }
    if (!response.ok) throw new Error("Invalid device code");
    const result = (await response.json()) as { status: string };
    if (result.status !== "pending") {
      return context.html(
        htmlPage(
          "Authorize Device",
          `<p>This device request has already been ${escapeHtml(result.status)}.</p>`,
          { authenticated: true },
        ),
        400,
      );
    }
  } catch {
    return context.html(
      htmlPage(
        "Authorize Device",
        "<p>This device code is invalid or has expired.</p>",
        { authenticated: true },
      ),
      400,
    );
  }

  return context.html(
    htmlPage(
      "Authorize Device",
      `<div class="card">
        <p>Confirm that this code matches the one shown in your terminal:</p>
        <p style="text-align:center"><span class="code-verify">${escapeHtml(userCode)}</span></p>
        <div class="button-row" style="justify-content:center">
          ${authForm(
            context,
            "device",
            `
            <input type="hidden" name="user_code" value="${escapeHtml(userCode)}">
            <button type="submit" name="decision" value="approve">Authorize</button>
            <button class="secondary" type="submit" name="decision" value="deny">Deny</button>`,
          )}
        </div>
      </div>`,
      {
        authenticated: true,
        narrow: true,
        description:
          "A command-line client is requesting access to your account.",
      },
    ),
  );
});

authPagesRouter.get("/invitations/:invitationId", async (context) => {
  const invitationId = context.req.param("invitationId");
  const next = `/auth/invitations/${encodeURIComponent(invitationId)}`;
  if (!(await isAuthenticated(context))) {
    return context.redirect(authPath("/auth/login", { next }));
  }

  try {
    const invitation = await context.get("services").auth.api.getInvitation({
      query: { id: invitationId },
      headers: context.req.raw.headers,
    });
    return context.html(
      htmlPage(
        "Organization Invitation",
        `<div class="card">
          <div class="identity" style="margin-block-end:1rem">
            <span class="identity__avatar" aria-hidden="true">${escapeHtml(invitation.organizationName.charAt(0))}</span>
            <div>
              <div class="identity__name">${escapeHtml(invitation.organizationName)}</div>
              <div class="identity__detail">Invited by ${escapeHtml(invitation.inviterEmail)}</div>
            </div>
            <span class="badge badge--accent" style="margin-inline-start:auto">${escapeHtml(invitation.role)}</span>
          </div>
          ${authForm(
            context,
            "invitation",
            `
            <input type="hidden" name="invitation_id" value="${escapeHtml(invitationId)}">
            <button type="submit">Accept Invitation</button>`,
          )}
        </div>`,
        { authenticated: true, narrow: true },
      ),
    );
  } catch {
    return context.html(
      htmlPage(
        "Organization Invitation",
        "<p>This invitation is invalid, expired, or belongs to another account.</p>",
        { authenticated: true },
      ),
      400,
    );
  }
});

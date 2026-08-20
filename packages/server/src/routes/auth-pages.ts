import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";

import type { AppEnvironment } from "../env";
import {
  THEME_COOKIE,
  escapeHtml,
  getExternalOrigin,
  htmlPage,
  parseTheme,
} from "../html";
import {
  createOrganizationForUser,
  createOrganizationSchema,
  OrganizationSlugExistsError,
} from "../organizations";

export const authPagesRouter = new Hono<AppEnvironment>();

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
    !next.startsWith("//") &&
    (next.startsWith("/auth/") ||
      next.startsWith("/api/auth/oauth2/authorize?"))
    ? next
    : undefined;
}

function oauthContinuation(
  context: Context<AppEnvironment>,
): string | undefined {
  const parameters = new URL(context.req.url).searchParams;
  return parameters.has("client_id") && parameters.has("sig")
    ? `/api/auth/oauth2/authorize?${parameters.toString()}`
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

function copySetCookies(from: Response, to: Response): void {
  for (const cookie of from.headers.getSetCookie()) {
    to.headers.append("Set-Cookie", cookie);
  }
}

function authRequest(
  context: Context<AppEnvironment>,
  path: string,
  body?: unknown,
): Request {
  const config = context.get("config");
  const headers = new Headers(context.req.raw.headers);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(new URL(path, config.betterAuthUrl), {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

authPagesRouter.get("/login", async (context) => {
  if (await isAuthenticated(context))
    return context.redirect("/auth/dashboard");
  const next = authNext(context) ?? oauthContinuation(context);
  const action = authPath("/auth/login", { next });
  const signupHref = authPath("/auth/signup", { next });
  const googleHref = authPath("/auth/google", { next });
  const { googleClientId, googleClientSecret } = context.get("config");
  const googleLogin =
    googleClientId && googleClientSecret
      ? `<a class="button secondary" href="${escapeHtml(googleHref)}">Continue with Google</a>`
      : "";

  return context.html(
    htmlPage(
      "Log In",
      `${messageBanner(context)}
    <div class="card">
      <form method="POST" action="${escapeHtml(action)}">
        <label>Email<br><input type="email" name="email" required autocomplete="email"></label><br><br>
        <label>Password<br><input type="password" name="password" required autocomplete="current-password"></label><br><br>
        <button type="submit">Log In</button>
      </form>
    </div>
    <div class="stack" style="margin-block-start:1rem">
      ${googleLogin}
      <a class="button ghost" href="/auth/magic-link">Log in with a magic link</a>
    </div>
    <p class="small muted" style="margin-block-start:1.25rem;text-align:center">
      Don't have an account? <a href="${escapeHtml(signupHref)}">Sign up</a> ·
      <a href="/auth/forgot-password">Forgot password?</a>
    </p>`,
      { narrow: true, description: "Sign in to The Last SaaS." },
    ),
  );
});

authPagesRouter.post("/login", async (context) => {
  const form = await context.req.parseBody();
  const authResponse = await context.get("services").auth.handler(
    authRequest(context, "/api/auth/sign-in/email", {
      email: String(form.email ?? ""),
      password: String(form.password ?? ""),
    }),
  );

  const next = authNext(context);
  if (!authResponse.ok) {
    return context.redirect(
      authPath("/auth/login", { next, error: "Invalid credentials" }),
    );
  }

  const redirect = context.redirect(next ?? "/auth/dashboard");
  copySetCookies(authResponse, redirect);
  return redirect;
});

authPagesRouter.get("/signup", async (context) => {
  if (await isAuthenticated(context))
    return context.redirect("/auth/dashboard");
  const next = authNext(context);
  const action = authPath("/auth/signup", { next });
  const prefillEmail = context.req.query("email") ?? "";
  const emailAttributes = prefillEmail
    ? ` value="${escapeHtml(prefillEmail)}" readonly`
    : "";

  return context.html(
    htmlPage(
      "Sign Up",
      `${messageBanner(context)}
    <div class="card">
      <form method="POST" action="${escapeHtml(action)}">
        <label>Name<br><input type="text" name="name" required autocomplete="name"></label><br><br>
        <label>Email<br><input type="email" name="email" required autocomplete="email"${emailAttributes}></label><br><br>
        <label>Password<br><input type="password" name="password" required minlength="8" autocomplete="new-password"></label><br><br>
        <button type="submit">Create Account</button>
        <p class="small muted" style="margin-block-start:0.75rem">Free while in beta. No card, no sales call.</p>
      </form>
    </div>
    <p class="small muted" style="margin-block-start:1.25rem;text-align:center">
      Next, connecting your assistant is one paste. Then you just ask.
    </p>
    <p class="small muted" style="margin-block-start:0.5rem;text-align:center">
      Already have an account? <a href="/auth/login">Log in</a>
    </p>`,
      { narrow: true, description: "One account, then your assistant does the rest." },
    ),
  );
});

authPagesRouter.post("/signup", async (context) => {
  const form = await context.req.parseBody();
  const name = String(form.name ?? "");
  const email = String(form.email ?? "");
  const password = String(form.password ?? "");
  const next = authNext(context);

  try {
    await context.get("services").auth.api.signUpEmail({
      body: { name, email, password },
      headers: context.req.raw.headers,
    });
    return context.redirect(
      authPath("/auth/login", {
        next,
        message: "Account created. Please log in.",
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Signup failed";
    return context.redirect(
      authPath("/auth/signup", { next, email, error: message }),
    );
  }
});

authPagesRouter.get("/magic-link", (context) =>
  context.html(
    htmlPage(
      "Magic Link",
      `${messageBanner(context)}
    <div class="card">
      <form method="POST" action="/auth/magic-link">
        <label>Email<br><input type="email" name="email" required autocomplete="email"></label><br><br>
        <button type="submit">Send Magic Link</button>
      </form>
    </div>`,
      {
        narrow: true,
        description: "We'll email you a link that signs you in — no password.",
      },
    ),
  ),
);

authPagesRouter.post("/magic-link", async (context) => {
  const form = await context.req.parseBody();
  const email = String(form.email ?? "");

  try {
    await context.get("services").auth.api.signInMagicLink({
      body: { email, callbackURL: "/auth/dashboard" },
      headers: context.req.raw.headers,
    });
  } catch {
    // Do not reveal whether an account exists.
  }

  return context.html(
    htmlPage(
      "Check Your Email",
      `<div class="card">
        <p>If an account exists for <strong>${escapeHtml(email)}</strong>, a magic link has been sent. The link expires shortly, so use it soon.</p>
      </div>`,
      { narrow: true },
    ),
  );
});

authPagesRouter.get("/forgot-password", (context) =>
  context.html(
    htmlPage(
      "Forgot Password",
      `${messageBanner(context)}
    <div class="card">
      <form method="POST" action="/auth/forgot-password">
        <label>Email<br><input type="email" name="email" required autocomplete="email"></label><br><br>
        <button type="submit">Send Reset Link</button>
      </form>
    </div>
    <p class="small muted" style="margin-block-start:1.25rem;text-align:center">
      <a href="/auth/login">Back to log in</a>
    </p>`,
      {
        narrow: true,
        description: "Enter your email and we'll send a reset link.",
      },
    ),
  ),
);

authPagesRouter.post("/forgot-password", async (context) => {
  const form = await context.req.parseBody();
  const email = String(form.email ?? "");

  try {
    await context.get("services").auth.api.requestPasswordReset({
      body: { email, redirectTo: "/auth/reset-password" },
      headers: context.req.raw.headers,
    });
  } catch {
    // Do not reveal whether an account exists.
  }

  return context.html(
    htmlPage(
      "Check Your Email",
      `<div class="card">
        <p>If an account exists for <strong>${escapeHtml(email)}</strong>, a password reset link has been sent.</p>
      </div>`,
      { narrow: true },
    ),
  );
});

authPagesRouter.get("/reset-password", (context) => {
  const token = context.req.query("token") ?? "";
  return context.html(
    htmlPage(
      "Reset Password",
      `${messageBanner(context)}
    <div class="card">
      <form method="POST" action="/auth/reset-password">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <label>New Password<br><input type="password" name="newPassword" required minlength="8" autocomplete="new-password"></label><br><br>
        <button type="submit">Reset Password</button>
      </form>
    </div>`,
      {
        narrow: true,
        description: "Choose a new password of at least 8 characters.",
      },
    ),
  );
});

authPagesRouter.post("/reset-password", async (context) => {
  const form = await context.req.parseBody();
  const token = String(form.token ?? "");
  const newPassword = String(form.newPassword ?? "");

  try {
    await context.get("services").auth.api.resetPassword({
      body: { token, newPassword },
      headers: context.req.raw.headers,
    });
    return context.redirect(
      authPath("/auth/login", {
        message: "Password reset successfully. Please log in.",
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reset failed";
    return context.redirect(
      authPath("/auth/reset-password", { token, error: message }),
    );
  }
});

authPagesRouter.get("/google", async (context) => {
  const config = context.get("config");
  const next = authNext(context);
  if (!config.googleClientId || !config.googleClientSecret) {
    return context.redirect(
      authPath("/auth/login", {
        next,
        error: "Google login is not configured",
      }),
    );
  }

  const authResponse = await context.get("services").auth.handler(
    authRequest(context, "/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: next ?? "/auth/dashboard",
      errorCallbackURL: authPath("/auth/login", {
        next,
        error: "Google login failed",
      }),
    }),
  );

  if (!authResponse.ok) {
    return context.redirect(
      authPath("/auth/login", { next, error: "Google login failed" }),
    );
  }

  const result = (await authResponse.json()) as { url?: string };
  if (!result.url) {
    return context.redirect(
      authPath("/auth/login", { next, error: "Google login failed" }),
    );
  }

  const redirect = context.redirect(result.url);
  copySetCookies(authResponse, redirect);
  return redirect;
});

authPagesRouter.get("/logout", async (context) => {
  const next = authNext(context);
  const redirect = context.redirect(authPath("/auth/login", { next }));

  try {
    const authResponse = await context
      .get("services")
      .auth.handler(authRequest(context, "/api/auth/sign-out", {}));
    copySetCookies(authResponse, redirect);
  } catch {
    // An already-expired session is still successfully logged out.
  }

  return redirect;
});

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
        authPath("/auth/mcp", {
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

authPagesRouter.get("/install", async (context) => {
  const server = getExternalOrigin(
    context.req.raw,
    context.get("config")?.betterAuthUrl,
  );
  const oneLiner = `curl -fsSL ${server}/install.sh | sh`;
  const binaries = [
    ["Linux x64", "linux-x64", "saas"],
    ["Linux arm64", "linux-arm64", "saas"],
    ["macOS x64 (Intel)", "darwin-x64", "saas"],
    ["macOS arm64 (Apple Silicon)", "darwin-arm64", "saas"],
    ["Windows x64", "windows-x64", "saas.exe"],
  ]
    .map(
      ([label, platform, file]) =>
        `<li class="record">
          <div class="record__body"><div class="record__title">${escapeHtml(label)}</div></div>
          <a class="button secondary" href="/dl/${platform}/${file}">Download</a>
        </li>`,
    )
    .join("");

  return context.html(
    htmlPage(
      "Install CLI",
      `<h2>Quick install (Linux / macOS)</h2>
    <pre><code>${escapeHtml(oneLiner)}</code></pre>
    <p class="small muted">Detects your OS and architecture, downloads the matching binary, and installs it to <code>$HOME/.local/bin/saas</code>. Override the destination with <code>LASTSAAS_INSTALL_DIR=~/bin</code>.</p>

    <h2>Manual download</h2>
    <ul class="record-list">${binaries}</ul>
    <p class="small muted" style="margin-block-start:0.75rem">After downloading on Linux or macOS, make it executable (<code>chmod +x saas</code>) and move it somewhere on your <code>$PATH</code>.</p>

    <h2>First run</h2>
    <pre><code>saas login --server ${escapeHtml(server)}</code></pre>
    <p class="small muted">This opens a browser window to complete authentication. See <a href="/auth/dashboard">your dashboard</a> once signed in.</p>`,
      {
        authenticated: await isAuthenticated(context),
        current: "/auth/install",
        description:
          "The saas CLI lets you manage your account on The Last SaaS from a terminal.",
      },
    ),
  );
});

authPagesRouter.get("/mcp", async (context) => {
  const { auth, prisma } = context.get("services");
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session?.user) return context.redirect("/auth/login");

  const server = getExternalOrigin(
    context.req.raw,
    context.get("config")?.betterAuthUrl,
  );
  const memberships = await prisma.member.count({
    where: { userId: session.user.id },
  });
  const endpoint = `${server}/v1/mcp`;
  const availability = memberships
    ? ""
    : `<div class="empty">
        <h3>No organizations yet</h3>
        <p><a href="/auth/dashboard">Create an organization</a> or join one before connecting ChatGPT or Claude.</p>
      </div>`;

  return context.html(
    htmlPage(
      "MCP Server",
      `${messageBanner(context)}${availability}
      <h2>Remote MCP URL</h2>
      <pre><code>${escapeHtml(endpoint)}</code></pre>
      <p class="small muted">Your AI client opens this site so you can sign in, choose an organization, and approve access. No CLI or copied token is required.</p>

      <h2>Connect ChatGPT</h2>
      <ol>
        <li>Enable developer mode in ChatGPT's app settings.</li>
        <li>Create a custom app and enter the remote MCP URL above.</li>
        <li>Choose OAuth authentication, then select <strong>Scan tools</strong>.</li>
        <li>Sign in here, select an organization, and approve access.</li>
      </ol>

      <h2>Connect Claude</h2>
      <ol>
        <li>Open <strong>Customize → Connectors</strong>.</li>
        <li>Add a custom connector and enter the remote MCP URL above.</li>
        <li>Select <strong>Connect</strong>.</li>
        <li>Sign in here, select an organization, and approve access.</li>
      </ol>

      <p class="small muted">Prefer a terminal? <a href="/auth/install">Install the CLI</a> instead.</p>`,
      {
        authenticated: true,
        current: "/auth/mcp",
        description:
          "Connect ChatGPT, Claude, or any MCP client to The Last SaaS.",
      },
    ),
  );
});

function oauthQuery(context: Context<AppEnvironment>): string {
  return new URL(context.req.url).searchParams.toString();
}

function redirectFromOAuthResult(
  context: Context<AppEnvironment>,
  result: { url?: string },
): Response {
  if (!result.url) {
    return context.html(
      htmlPage(
        "Connection Failed",
        '<p class="alert alert--error">The authorization server did not provide a return URL. Start the connection again from your MCP client.</p>',
        { authenticated: true, narrow: true },
      ),
      400,
    );
  }
  return context.redirect(result.url, 303);
}

async function runOAuthAction(
  context: Context<AppEnvironment>,
  path: string,
  body: Record<string, unknown>,
): Promise<{ url?: string }> {
  const response = await context
    .get("services")
    .auth.handler(authRequest(context, path, body));
  if (!response.ok) {
    throw new Error(`OAuth action failed with status ${response.status}`);
  }
  return (await response.json()) as { url?: string };
}

authPagesRouter.get("/mcp/select-organization", async (context) => {
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
      organization: { select: { id: true, name: true } },
    },
  });
  const choices = memberships.length
    ? memberships
        .map(
          ({ organization, role }, index) => `<label class="record">
            <input type="radio" name="organizationId" value="${escapeHtml(organization.id)}"${index === 0 ? " checked" : ""} required>
            <span class="record__body">
              <span class="record__title">${escapeHtml(organization.name)}</span>
              <span class="record__meta">${escapeHtml(role)}</span>
            </span>
          </label>`,
        )
        .join("")
    : '<div class="empty"><h3>No organizations available</h3><p>Create or join an organization, then start the connection again.</p></div>';
  const action = memberships.length
    ? `<button type="submit">Continue</button>`
    : "";

  return context.html(
    htmlPage(
      "Choose an Organization",
      `<form method="POST" action="/auth/mcp/select-organization">
        <input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery(context))}">
        <div class="record-list">${choices}</div>
        <div class="button-row" style="margin-block-start:1rem">${action}</div>
      </form>`,
      {
        authenticated: true,
        narrow: true,
        description:
          "Choose which organization's data this connection may access.",
      },
    ),
  );
});

authPagesRouter.post("/mcp/select-organization", csrf(), async (context) => {
  const form = await context.req.parseBody();
  const organizationId = String(form.organizationId ?? "");
  const oauth_query = String(form.oauth_query ?? "");
  const { auth, prisma } = context.get("services");
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session?.user) return context.redirect("/auth/login");
  const membership = await prisma.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId: session.user.id,
      },
    },
    select: { id: true },
  });
  if (!membership) {
    return context.html(
      htmlPage(
        "Choose an Organization",
        '<p class="alert alert--error">You are not a member of that organization. Start the connection again.</p>',
        { authenticated: true, narrow: true },
      ),
      403,
    );
  }

  await auth.api.setActiveOrganization({
    body: { organizationId },
    headers: context.req.raw.headers,
  });
  const result = await runOAuthAction(context, "/api/auth/oauth2/continue", {
    postLogin: true,
    oauth_query,
  });
  return redirectFromOAuthResult(context, result);
});

authPagesRouter.get("/mcp/consent", async (context) => {
  const { auth } = context.get("services");
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session?.user) return context.redirect("/auth/login");
  const clientId = context.req.query("client_id") ?? "";
  const client = await auth.api
    .getOAuthClientPublic({
      query: { client_id: clientId },
      headers: context.req.raw.headers,
    })
    .catch(() => null);
  if (!client) {
    return context.html(
      htmlPage(
        "Authorize Connection",
        '<p class="alert alert--error">The requesting MCP client is unknown or the authorization request has expired.</p>',
        { authenticated: true, narrow: true },
      ),
      400,
    );
  }
  const clientName = client.client_name || "MCP client";
  const scopes = (context.req.query("scope") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
    .join("");

  return context.html(
    htmlPage(
      "Authorize Connection",
      `<div class="card">
        <p><strong>${escapeHtml(clientName)}</strong> is requesting access to the organization you selected.</p>
        <p class="small muted">Requested access:</p>
        <ul>${scopes}</ul>
        <p>The client will be able to use Last SaaS tools with your existing organization permissions.</p>
      </div>
      <form method="POST" action="/auth/mcp/consent" style="margin-block-start:1rem">
        <input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery(context))}">
        <div class="button-row">
          <button type="submit" name="decision" value="allow">Allow access</button>
          <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
        </div>
      </form>`,
      {
        authenticated: true,
        narrow: true,
        description:
          "Review this request before sharing access to your organization.",
      },
    ),
  );
});

authPagesRouter.post("/mcp/consent", csrf(), async (context) => {
  const form = await context.req.parseBody();
  const result = await runOAuthAction(context, "/api/auth/oauth2/consent", {
    accept: form.decision === "allow",
    oauth_query: String(form.oauth_query ?? ""),
  });
  return redirectFromOAuthResult(context, result);
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
    const response = await context
      .get("services")
      .auth.handler(
        authRequest(
          context,
          `/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
        ),
      );
    if (!response.ok) throw new Error(`Device verification failed`);
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
          <form method="POST" action="/auth/device/approve">
            <input type="hidden" name="user_code" value="${escapeHtml(userCode)}">
            <button type="submit">Authorize</button>
          </form>
          <form method="POST" action="/auth/device/deny">
            <input type="hidden" name="user_code" value="${escapeHtml(userCode)}">
            <button class="secondary" type="submit">Deny</button>
          </form>
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

authPagesRouter.post("/device/approve", csrf(), async (context) => {
  const form = await context.req.parseBody();
  const userCode = String(form.user_code ?? "");
  if (!(await isAuthenticated(context))) {
    const next = authPath("/auth/device", { user_code: userCode });
    return context.redirect(authPath("/auth/login", { next }));
  }

  try {
    await context.get("services").auth.api.deviceApprove({
      body: { userCode },
      headers: context.req.raw.headers,
    });
    return context.html(
      htmlPage(
        "Device Authorized",
        "<p>The device is authorized. You can close this tab and return to the CLI.</p>",
        { authenticated: true },
      ),
    );
  } catch {
    return context.html(
      htmlPage(
        "Authorize Device",
        "<p>This device request could not be authorized. It may have expired or already been processed.</p>",
        { authenticated: true },
      ),
      400,
    );
  }
});

authPagesRouter.post("/device/deny", csrf(), async (context) => {
  const form = await context.req.parseBody();
  const userCode = String(form.user_code ?? "");
  if (!(await isAuthenticated(context))) {
    const next = authPath("/auth/device", { user_code: userCode });
    return context.redirect(authPath("/auth/login", { next }));
  }

  try {
    await context.get("services").auth.api.deviceDeny({
      body: { userCode },
      headers: context.req.raw.headers,
    });
    return context.html(
      htmlPage(
        "Device Denied",
        "<p>The device request was denied. You can close this tab.</p>",
        { authenticated: true },
      ),
    );
  } catch {
    return context.html(
      htmlPage(
        "Authorize Device",
        "<p>This device request could not be denied. It may have expired or already been processed.</p>",
        { authenticated: true },
      ),
      400,
    );
  }
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
          <form method="POST" action="${escapeHtml(next)}">
            <button type="submit">Accept Invitation</button>
          </form>
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

authPagesRouter.post("/invitations/:invitationId", csrf(), async (context) => {
  const invitationId = context.req.param("invitationId");
  const next = `/auth/invitations/${encodeURIComponent(invitationId)}`;
  if (!(await isAuthenticated(context))) {
    return context.redirect(authPath("/auth/login", { next }));
  }

  try {
    await context.get("services").auth.api.acceptInvitation({
      body: { invitationId },
      headers: context.req.raw.headers,
    });
    return context.redirect(
      authPath("/auth/dashboard", {
        message: "Invitation accepted.",
      }),
    );
  } catch {
    return context.html(
      htmlPage(
        "Organization Invitation",
        "<p>This invitation could not be accepted. It may be invalid, expired, or belong to another account.</p>",
        { authenticated: true },
      ),
      400,
    );
  }
});

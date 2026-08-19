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
  return next?.startsWith("/auth/") && !next.startsWith("//")
    ? next
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
  const next = authNext(context);
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
      { narrow: true, description: "Sign in to your Last SaaS account." },
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
      </form>
    </div>
    <p class="small muted" style="margin-block-start:1.25rem;text-align:center">
      Already have an account? <a href="/auth/login">Log in</a>
    </p>`,
      { narrow: true, description: "Create an account to get started." },
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
      organization: { select: { id: true, name: true } },
    },
  });
  const organizations = memberships.length
    ? `<ul class="record-list">${memberships
        .map(
          ({ organization, role }) =>
            `<li class="record">
              <div class="record__body">
                <div class="record__title">${escapeHtml(organization.name)}</div>
                <div class="record__meta">${escapeHtml(organization.id)}</div>
              </div>
              <span class="badge">${escapeHtml(role)}</span>
            </li>`,
        )
        .join("")}</ul>`
    : `<div class="empty">
        <h3>No organizations yet</h3>
        <p>Install the CLI to create your first organization, or accept an invitation from an existing one.</p>
        <p style="margin-block-start:1.25rem"><a class="button" href="/auth/install">Install the CLI</a></p>
      </div>`;

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
    `,
      {
        authenticated: true,
        current: "/auth/dashboard",
      },
    ),
  );
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
          "The saas CLI lets you manage your Last SaaS account from a terminal.",
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
    const result = await context
      .get("services")
      .auth.api.deviceVerify({ query: { user_code: userCode } });
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

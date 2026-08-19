import { Hono, type Context } from "hono";

import type { AppEnvironment } from "../env";
import { escapeHtml, htmlPage } from "../html";

export const authPagesRouter = new Hono<AppEnvironment>();

function messageBanner(context: Context<AppEnvironment>): string {
  const error = context.req.query("error");
  const message = context.req.query("message");
  if (error) return `<p style="color:red">${escapeHtml(error)}</p>`;
  if (message) return `<p style="color:green">${escapeHtml(message)}</p>`;
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

authPagesRouter.get("/login", (context) => {
  const next = authNext(context);
  const action = authPath("/auth/login", { next });
  const signupHref = authPath("/auth/signup", { next });
  const googleHref = authPath("/auth/google", { next });
  const { googleClientId, googleClientSecret } = context.get("config");
  const googleLogin =
    googleClientId && googleClientSecret
      ? `<p><a href="${escapeHtml(googleHref)}">Continue with Google</a></p>`
      : "";

  return context.html(
    htmlPage(
      "Login",
      `${messageBanner(context)}
    <form method="POST" action="${escapeHtml(action)}">
      <label>Email<br><input type="email" name="email" required autocomplete="email"></label><br><br>
      <label>Password<br><input type="password" name="password" required autocomplete="current-password"></label><br><br>
      <button type="submit">Login</button>
    </form>
    ${googleLogin}
    <p><a href="/auth/magic-link">Login with Magic Link</a></p>
    <p>Don't have an account? <a href="${escapeHtml(signupHref)}">Sign up</a></p>`,
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

authPagesRouter.get("/signup", (context) => {
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
    <form method="POST" action="${escapeHtml(action)}">
      <label>Name<br><input type="text" name="name" required autocomplete="name"></label><br><br>
      <label>Email<br><input type="email" name="email" required autocomplete="email"${emailAttributes}></label><br><br>
      <label>Password<br><input type="password" name="password" required minlength="8" autocomplete="new-password"></label><br><br>
      <button type="submit">Sign Up</button>
    </form>`,
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
        message: "Account created. Please login.",
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
    <form method="POST" action="/auth/magic-link">
      <label>Email<br><input type="email" name="email" required autocomplete="email"></label><br><br>
      <button type="submit">Send Magic Link</button>
    </form>`,
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
      "Magic Link Sent",
      `<p>If an account exists for <strong>${escapeHtml(email)}</strong>, a magic link has been sent.</p>`,
    ),
  );
});

authPagesRouter.get("/forgot-password", (context) =>
  context.html(
    htmlPage(
      "Forgot Password",
      `${messageBanner(context)}
    <form method="POST" action="/auth/forgot-password">
      <label>Email<br><input type="email" name="email" required autocomplete="email"></label><br><br>
      <button type="submit">Send Reset Link</button>
    </form>`,
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
      "Reset Link Sent",
      `<p>If an account exists for <strong>${escapeHtml(email)}</strong>, a reset link has been sent.</p>`,
    ),
  );
});

authPagesRouter.get("/reset-password", (context) => {
  const token = context.req.query("token") ?? "";
  return context.html(
    htmlPage(
      "Reset Password",
      `${messageBanner(context)}
    <form method="POST" action="/auth/reset-password">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <label>New Password<br><input type="password" name="newPassword" required minlength="8" autocomplete="new-password"></label><br><br>
      <button type="submit">Reset Password</button>
    </form>`,
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
        message: "Password reset successfully. Please login.",
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
  const session = await context
    .get("services")
    .auth.api.getSession({ headers: context.req.raw.headers });
  if (!session?.user) return context.redirect("/auth/login");

  return context.html(
    htmlPage(
      "Dashboard",
      `${messageBanner(context)}
    <p>Logged in as <strong>${escapeHtml(session.user.name)}</strong> (${escapeHtml(session.user.email)})</p>
    <p>Active Org: ${escapeHtml(session.session.activeOrganizationId ?? "none")}</p>
    <p><a href="/auth/logout">Logout</a></p>`,
    ),
  );
});

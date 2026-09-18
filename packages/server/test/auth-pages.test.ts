import { afterEach, describe, expect, test } from "bun:test";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import { createAuth, type AuthEmail } from "../src/auth";
import { loadConfig } from "../src/config";
import { closeServices, createServices } from "../src/services";
import { verifyTestUser } from "./auth-helpers";
import { testMigrationSql } from "./test-migrations";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createAuthPageApp(
  options: { google?: boolean; passwordAuth?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-auth-pages-"));
  const emails: AuthEmail[] = [];
  const config = loadConfig({
    PASSWORD_AUTH_ENABLED: String(options.passwordAuth ?? true),
    NODE_ENV: "test",
    PORT: "3000",
    DATABASE_URL: `file:${join(directory, "test.db")}`,
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    BETTER_AUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: options.google ? "google-client-id" : "",
    GOOGLE_CLIENT_SECRET: options.google ? "google-client-secret" : "",
  });
  const services = await createServices(config, async (email) => {
    emails.push(email);
  });
  if (!services.database) throw new Error("Expected SQLite database handle");
  services.database.exec(testMigrationSql);
  const app = createApp({ config, services });
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, emails, services, config };
}

function googleIdToken(claims: Record<string, unknown>) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test-google-key", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString("base64url");
  const jwk = publicKey.export({ format: "jwk" });

  return {
    token: `${header}.${payload}.${signature}`,
    jwk: { ...jwk, alg: "RS256", kid: "test-google-key", use: "sig" },
  };
}

function formBody(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

async function signUp(
  app: Awaited<ReturnType<typeof createAuthPageApp>>["app"],
  password = "initial-password",
) {
  return app.request("http://localhost:3000/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      name: "Auth User",
      email: "auth-user@example.com",
      password,
    }),
  });
}

async function login(
  app: Awaited<ReturnType<typeof createAuthPageApp>>["app"],
  password: string,
) {
  return app.request("http://localhost:3000/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ email: "auth-user@example.com", password }),
  });
}

describe("browser auth pages", () => {
  test("disabled password auth hides forms and rejects direct password endpoints", async () => {
    const { app, services, emails } = await createAuthPageApp({
      passwordAuth: false,
      google: true,
    });
    const loginPage = await app.request(
      "http://localhost:3000/auth/login?next=%2Fauth%2Fdevice",
    );
    const html = await loginPage.text();
    expect(html).not.toContain('<input type="password"');
    expect(html).not.toContain("/auth/forgot-password");
    expect(html).toContain("Continue with Google");
    expect(html).toContain('action="/auth/magic-link?next=%2Fauth%2Fdevice"');
    const signupPage = await app.request(
      "http://localhost:3000/auth/signup?next=%2Fauth%2Fdevice&email=new%40example.com",
    );
    expect(signupPage.status).toBe(200);
    const signupHtml = await signupPage.text();
    expect(signupHtml).not.toContain('<input type="password"');
    expect(signupHtml).toContain(
      'action="/auth/magic-link?next=%2Fauth%2Fdevice"',
    );
    expect(signupHtml).toContain('value="new@example.com"');
    expect(signupHtml.indexOf("Email Me a Sign-Up Link")).toBeLessThan(
      signupHtml.indexOf("Continue with Google"),
    );
    expect(html.indexOf("Send Magic Link")).toBeLessThan(
      html.indexOf("Continue with Google"),
    );
    for (const path of ["forgot-password", "reset-password"]) {
      const page = await app.request(
        `http://localhost:3000/auth/${path}?next=%2Fauth%2Fdevice`,
      );
      expect(page.status).toBe(302);
      expect(page.headers.get("location")).toBe(
        "/auth/login?next=%2Fauth%2Fdevice",
      );
    }
    for (const path of [
      "login",
      "signup",
      "forgot-password",
      "reset-password",
    ]) {
      const response = await app.request(`http://localhost:3000/auth/${path}`, {
        method: "POST",
        body: formBody({
          email: "disabled@example.com",
          password: "initial-password",
        }),
      });
      expect(response.status).toBe(403);
    }
    for (const [path, body] of [
      [
        "sign-up/email",
        {
          name: "Disabled",
          email: "disabled@example.com",
          password: "initial-password",
        },
      ],
      [
        "sign-in/email",
        { email: "disabled@example.com", password: "initial-password" },
      ],
      ["request-password-reset", { email: "disabled@example.com" }],
      ["reset-password", { token: "old-token", newPassword: "new-password" }],
      [
        "change-password",
        { currentPassword: "initial-password", newPassword: "new-password" },
      ],
    ] as const) {
      const response = await app.request(
        `http://localhost:3000/api/auth/${path}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:3000",
          },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "PASSWORD_AUTH_DISABLED",
      });
    }
    await expect(
      services.auth.api.signUpEmail({
        body: {
          name: "Disabled",
          email: "disabled@example.com",
          password: "initial-password",
        },
      }),
    ).rejects.toThrow("Password authentication is disabled");
    expect(await services.prisma.user.count()).toBe(0);
    expect(emails).toHaveLength(0);

    const google = await app.request("http://localhost:3000/auth/google");
    expect(google.status).toBe(302);
    expect(google.headers.get("location")).toContain("accounts.google.com");
    const magicPage = await app.request(
      "http://localhost:3000/auth/magic-link?next=%2Fauth%2Fdevice",
    );
    expect(await magicPage.text()).toContain(
      'action="/auth/magic-link?next=%2Fauth%2Fdevice"',
    );
    await app.request(
      "http://localhost:3000/auth/magic-link?next=%2Fauth%2Fdevice",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost:3000",
        },
        body: formBody({ email: "magic-only@example.com" }),
      },
    );
    const email = emails.find((email) => email.type === "magic-link");
    expect(email).toBeDefined();
    const verified = await app.request(email!.url);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toContain("/auth/device");
    expect(verified.headers.get("set-cookie")).toContain("session_token");
  });

  test("disabling password auth preserves existing sessions and credentials", async () => {
    const { app, services, config } = await createAuthPageApp();
    await signUp(app);
    await verifyTestUser(services, "auth-user@example.com");
    const signedIn = await login(app, "initial-password");
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const disabledConfig = { ...config, passwordAuthEnabled: false };
    const disabledApp = createApp({
      config: disabledConfig,
      services: {
        ...services,
        auth: createAuth(services.prisma, disabledConfig),
      },
    });
    const dashboard = await disabledApp.request(
      "http://localhost:3000/auth/dashboard",
      { headers: { Cookie: cookie } },
    );
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("auth-user@example.com");
    expect((await login(disabledApp, "initial-password")).status).toBe(403);
    // Re-enabling uses the existing credentials; no migration or reset is needed.
    expect((await login(app, "initial-password")).status).toBe(302);
  });

  test("redirects the root and renders auth forms before protected routes", async () => {
    const { app } = await createAuthPageApp();

    const root = await app.request("http://localhost:3000/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/auth/signup");

    for (const [path, heading] of [
      ["/auth/login", "Log In"],
      ["/auth/signup", "Sign Up"],
      ["/auth/magic-link", "Magic Link"],
      ["/auth/forgot-password", "Forgot Password"],
      ["/auth/reset-password?token=test-token", "Reset Password"],
      ["/auth/install", "Install CLI"],
    ]) {
      const response = await app.request(`http://localhost:3000${path}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`<h1>${heading}</h1>`);
      expect(html).toContain('<a href="/auth/install">Install CLI</a>');
    }

    const install = await app.request("http://localhost:3000/auth/install");
    const installHtml = await install.text();
    expect(installHtml).toContain('href="/dl/linux-x64/saas"');
    expect(installHtml).toContain('href="/dl/windows-x64/saas.exe"');
    expect(installHtml).not.toContain("</a> — <code>");
  });

  test("signs up, logs in, renders the dashboard, and logs out", async () => {
    const { app, services } = await createAuthPageApp();

    const signup = await signUp(app);
    expect(signup.status).toBe(302);
    expect(signup.headers.get("location")).toBe(
      "/auth/login?message=Account+created.+Check+your+email+to+verify+your+address+before+logging+in.",
    );

    const unverifiedLogin = await login(app, "initial-password");
    expect(unverifiedLogin.status).toBe(302);
    expect(unverifiedLogin.headers.get("location")).toBe(
      "/auth/login?error=Email+not+verified.+Check+your+email+for+a+new+verification+link.",
    );

    await verifyTestUser(services, "auth-user@example.com");
    const loginResponse = await login(app, "initial-password");
    expect(loginResponse.status).toBe(302);
    expect(loginResponse.headers.get("location")).toBe("/auth/dashboard");
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const dashboard = await app.request(
      "http://localhost:3000/auth/dashboard",
      { headers: { Cookie: cookie! } },
    );
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('<a href="/auth/install">Install CLI</a>');
    expect(dashboardHtml).toContain('<a href="/auth/mcp">MCP Server</a>');
    /* Log out is an icon in the header, so the name is only in the label. */
    expect(dashboardHtml).toContain(
      '<a class="icon-link" href="/auth/logout" aria-label="Log Out"',
    );
    expect(dashboardHtml).not.toContain('<a href="/auth/login">');
    expect(dashboardHtml).not.toContain('<a href="/auth/signup">');
    expect(dashboardHtml).toContain("auth-user@example.com");
    expect(dashboardHtml).toContain("No organizations yet");
    expect(dashboardHtml).toContain(
      'form method="POST" action="/auth/dashboard/organizations"',
    );
    expect(dashboardHtml).toContain("Create Organization");
    expect(dashboardHtml).not.toContain(
      "Install the CLI to create your first organization",
    );

    const createdOrganization = await app.request(
      "http://localhost:3000/auth/dashboard/organizations",
      {
        method: "POST",
        headers: {
          Cookie: cookie!,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost:3000",
        },
        body: formBody({ name: "Browser Organization", slug: "browser-org" }),
      },
    );
    expect(createdOrganization.status).toBe(303);
    expect(createdOrganization.headers.get("location")).toBe(
      "/auth/mcp?message=Browser+Organization+created.+Next%2C+connect+your+assistant.",
    );

    const dashboardAfterCreation = await app.request(
      "http://localhost:3000/auth/dashboard",
      { headers: { Cookie: cookie! } },
    );
    expect(dashboardAfterCreation.status).toBe(200);
    const dashboardAfterCreationHtml = await dashboardAfterCreation.text();
    expect(dashboardAfterCreationHtml).toContain("Browser Organization");
    expect(dashboardAfterCreationHtml).toContain(">admin</span>");
    expect(dashboardAfterCreationHtml).not.toContain(
      'action="/auth/dashboard/organizations"',
    );
    expect(dashboardAfterCreationHtml).not.toContain("Create Organization");

    for (const path of ["/auth/login", "/auth/signup"]) {
      const response = await app.request(`http://localhost:3000${path}`, {
        headers: { Cookie: cookie! },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/auth/dashboard");
    }

    const install = await app.request("http://localhost:3000/auth/install", {
      headers: { Cookie: cookie! },
    });
    const installHtml = await install.text();
    expect(installHtml).toContain(
      '<a class="icon-link" href="/auth/logout" aria-label="Log Out"',
    );
    expect(installHtml).not.toContain('<a href="/auth/login">');
    expect(installHtml).not.toContain('<a href="/auth/signup">');

    const authenticatedRoot = await app.request("http://localhost:3000/", {
      headers: { Cookie: cookie! },
    });
    expect(authenticatedRoot.status).toBe(302);
    expect(authenticatedRoot.headers.get("location")).toBe("/auth/dashboard");

    const logout = await app.request("http://localhost:3000/auth/logout", {
      headers: { Cookie: cookie! },
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("renders browser-based MCP setup instructions", async () => {
    const { app, services } = await createAuthPageApp();
    await signUp(app);
    await verifyTestUser(services, "auth-user@example.com");
    const loginResponse = await login(app, "initial-password");
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const unauthenticated = await app.request("http://localhost:3000/auth/mcp");
    expect(unauthenticated.status).toBe(200);
    const anonymousHtml = await unauthenticated.text();
    expect(anonymousHtml).toContain("No account yet");
    expect(anonymousHtml).toContain('<a href="/auth/signup">');
    expect(anonymousHtml).toContain("http://localhost:3000/v1/mcp");

    const created = await app.request("http://localhost:3000/v1/orgs", {
      method: "POST",
      headers: {
        Cookie: cookie!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "MCP Test Org", slug: "mcp-test-org" }),
    });
    expect(created.status).toBe(201);
    await created.json();

    const page = await app.request("http://localhost:3000/auth/mcp", {
      headers: { Cookie: cookie! },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<h1>MCP Server</h1>");
    expect(html).toContain("http://localhost:3000/v1/mcp");
    expect(html).toContain("ChatGPT");
    expect(html).toContain("Claude");
    expect(html).toContain("No CLI or copied token is required");
    expect(html).not.toContain("session_token");
    expect(html).toContain('aria-current="page">MCP Server</a>');
  });

  test("completes MCP OAuth discovery, consent, token, and refresh", async () => {
    const { app, services } = await createAuthPageApp();
    await signUp(app);
    await verifyTestUser(services, "auth-user@example.com");
    const loginResponse = await login(app, "initial-password");
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const created = await app.request("http://localhost:3000/v1/orgs", {
      method: "POST",
      headers: {
        Cookie: cookie!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "OAuth Org", slug: "oauth-org" }),
    });
    expect(created.status).toBe(201);

    const protectedMetadata = await app.request(
      "http://localhost:3000/.well-known/oauth-protected-resource/v1/mcp",
    );
    expect(protectedMetadata.status).toBe(200);
    expect(await protectedMetadata.json()).toMatchObject({
      resource: "http://localhost:3000/v1/mcp",
      authorization_servers: ["http://localhost:3000/api/auth"],
    });
    const authMetadata = await app.request(
      "http://localhost:3000/.well-known/oauth-authorization-server/api/auth",
    );
    expect(authMetadata.status).toBe(200);
    expect(await authMetadata.json()).toMatchObject({
      issuer: "http://localhost:3000/api/auth",
      authorization_endpoint: "http://localhost:3000/api/auth/oauth2/authorize",
      token_endpoint: "http://localhost:3000/api/auth/oauth2/token",
      registration_endpoint: "http://localhost:3000/api/auth/oauth2/register",
    });

    const registration = await app.request(
      "http://localhost:3000/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "OAuth Test Client",
          redirect_uris: ["https://client.example/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "openid profile offline_access mcp:tools",
        }),
      },
    );
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(
      "http://localhost:3000/api/auth/oauth2/authorize",
    );
    authorize.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      scope: "openid profile offline_access mcp:tools",
      resource: "http://localhost:3000/v1/mcp",
      state: "oauth-test-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    const unauthenticatedAuthorize = await app.request(authorize);
    expect(unauthenticatedAuthorize.status).toBe(302);
    expect(unauthenticatedAuthorize.headers.get("location")).toStartWith(
      "/auth/login?",
    );

    const authorized = await app.request(authorize, {
      headers: { Cookie: cookie! },
    });
    expect(authorized.status).toBe(302);
    const consentLocation = authorized.headers.get("location");
    expect(consentLocation).toStartWith("/auth/mcp/consent?");
    const consentQuery = new URL(
      consentLocation!,
      "http://localhost:3000",
    ).searchParams.toString();

    const consentPage = await app.request(
      new URL(consentLocation!, "http://localhost:3000"),
      { headers: { Cookie: cookie! } },
    );
    expect(consentPage.status).toBe(200);
    expect(await consentPage.text()).toContain("OAuth Test Client");

    const consent = await app.request(
      "http://localhost:3000/auth/mcp/consent",
      {
        method: "POST",
        headers: {
          Cookie: cookie!,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost:3000",
        },
        body: formBody({ decision: "allow", oauth_query: consentQuery }),
      },
    );
    expect(consent.status).toBe(303);
    const callback = new URL(consent.headers.get("location")!);
    expect(callback.origin).toBe("https://client.example");
    expect(callback.searchParams.get("state")).toBe("oauth-test-state");
    expect(callback.searchParams.get("code")).toBeTruthy();

    const token = await app.request(
      "http://localhost:3000/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          redirect_uri: "https://client.example/callback",
          code: callback.searchParams.get("code")!,
          code_verifier: verifier,
          resource: "http://localhost:3000/v1/mcp",
        }),
      },
    );
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
      token_type: string;
    };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.scope).toContain("mcp:tools");
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1]!, "base64url").toString(),
    ) as Record<string, unknown>;
    expect(claims.aud).toContain("http://localhost:3000/v1/mcp");
    expect(claims["https://thelastsaas.com/claims/account_access"]).toBe(true);

    const refreshed = await app.request(
      "http://localhost:3000/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
          resource: "http://localhost:3000/v1/mcp",
        }),
      },
    );
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).access_token).toBeTruthy();

    const challengeResponse = await app.request(
      "http://localhost:3000/v1/mcp",
      { method: "POST" },
    );
    expect(challengeResponse.status).toBe(401);
    expect(challengeResponse.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
  });

  test("sends and verifies a magic link without revealing unknown users", async () => {
    const { app, emails } = await createAuthPageApp();
    await signUp(app);

    const sent = await app.request("http://localhost:3000/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ email: "auth-user@example.com" }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain(
      "following the link will create your account",
    );
    const email = emails.find((candidate) => candidate.type === "magic-link");
    expect(email?.to).toBe("auth-user@example.com");

    const verified = await app.request(email!.url);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toContain("/auth/dashboard");
    expect(verified.headers.get("set-cookie")).toBeTruthy();
  });

  test("completes password reset and accepts only the new password", async () => {
    const { app, emails, services } = await createAuthPageApp();
    await signUp(app);
    await verifyTestUser(services, "auth-user@example.com");

    const requested = await app.request(
      "http://localhost:3000/auth/forgot-password",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody({ email: "auth-user@example.com" }),
      },
    );
    expect(requested.status).toBe(200);
    const email = emails.find(
      (candidate) => candidate.type === "password-reset",
    );
    expect(email).toBeDefined();

    const resetLink = await app.request(email!.url);
    expect(resetLink.status).toBe(302);
    const resetLocation = resetLink.headers.get("location");
    expect(resetLocation).toContain("/auth/reset-password?token=");
    const token = new URL(
      resetLocation!,
      "http://localhost:3000",
    ).searchParams.get("token");
    expect(token).toBeTruthy();

    const reset = await app.request(
      "http://localhost:3000/auth/reset-password",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody({ token: token!, newPassword: "replacement-password" }),
      },
    );
    expect(reset.status).toBe(302);
    expect(
      (await login(app, "initial-password")).headers.get("location"),
    ).toContain("error=Invalid+credentials");
    expect(
      (await login(app, "replacement-password")).headers.get("location"),
    ).toBe("/auth/dashboard");
  });

  test("renders configured Google OAuth links and preserves a safe auth next path", async () => {
    const { app } = await createAuthPageApp({ google: true });

    const loginPage = await app.request("http://localhost:3000/auth/login");
    expect(await loginPage.text()).toContain("Continue with Google");

    const signupPage = await app.request(
      "http://localhost:3000/auth/signup?next=%2Fauth%2Fdevice%2Fauthorize%3Fstate%3Dcli",
    );
    expect(await signupPage.text()).toContain(
      'href="/auth/google?next=%2Fauth%2Fdevice%2Fauthorize%3Fstate%3Dcli"',
    );

    const { app: appWithoutGoogle } = await createAuthPageApp();
    const loginWithoutGoogle = await appWithoutGoogle.request(
      "http://localhost:3000/auth/login",
    );
    expect(await loginWithoutGoogle.text()).not.toContain(
      "Continue with Google",
    );

    const signupWithoutGoogle = await appWithoutGoogle.request(
      "http://localhost:3000/auth/signup",
    );
    const signupWithoutGoogleHtml = await signupWithoutGoogle.text();
    expect(signupWithoutGoogleHtml).not.toContain("Continue with Google");
    expect(signupWithoutGoogleHtml).not.toContain('<div class="stack"');

    const unavailable = await appWithoutGoogle.request(
      "http://localhost:3000/auth/google",
    );
    expect(unavailable.status).toBe(302);
    const unavailablePage = await appWithoutGoogle.request(
      new URL(unavailable.headers.get("location")!, "http://localhost:3000"),
    );
    expect(await unavailablePage.text()).toContain(
      "Google login is not configured",
    );

    const response = await app.request(
      "http://localhost:3000/auth/google?next=%2Fauth%2Fdevice%2Fauthorize%3Fstate%3Dcli",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith(
      "https://accounts.google.com/",
    );
    expect(response.headers.get("set-cookie")).toBeTruthy();
  });

  test("links Google sign-in to an existing verified password user", async () => {
    const { app, services } = await createAuthPageApp({ google: true });
    await signUp(app);
    const passwordUser = await services.prisma.user.findUniqueOrThrow({
      where: { email: "auth-user@example.com" },
    });
    await services.prisma.user.update({
      where: { id: passwordUser.id },
      data: { emailVerified: true },
    });

    const authorization = await app.request(
      "http://localhost:3000/auth/google",
    );
    const authorizationUrl = new URL(authorization.headers.get("location")!);
    const state = authorizationUrl.searchParams.get("state");
    const cookie = authorization.headers.get("set-cookie")?.split(";")[0];
    expect(state).toBeTruthy();
    expect(cookie).toBeTruthy();

    const now = Math.floor(Date.now() / 1000);
    const { token, jwk } = googleIdToken({
      iss: "https://accounts.google.com",
      aud: "google-client-id",
      sub: "google-user-id",
      email: "auth-user@example.com",
      email_verified: true,
      name: "Google Auth User",
      picture: "https://example.com/avatar.png",
      iat: now,
      exp: now + 3600,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({
          access_token: "google-access-token",
          expires_in: 3600,
          id_token: token,
          token_type: "Bearer",
        });
      }
      if (url === "https://www.googleapis.com/oauth2/v3/certs") {
        return Response.json({ keys: [jwk] });
      }
      throw new Error(`Unexpected Google OAuth request: ${url}`);
    }) as typeof fetch;

    try {
      const callback = await app.request(
        `http://localhost:3000/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state!)}`,
        { headers: { Cookie: cookie! } },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("/auth/dashboard");

      const users = await services.prisma.user.findMany({
        where: { email: "auth-user@example.com" },
        include: { accounts: true },
      });
      expect(users).toHaveLength(1);
      expect(users[0]?.id).toBe(passwordUser.id);
      expect(users[0]?.accounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: "google-user-id",
            providerId: "google",
            userId: passwordUser.id,
          }),
        ]),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("escapes auth-page query values and rejects external next redirects", async () => {
    const { app } = await createAuthPageApp();
    const page = await app.request(
      "http://localhost:3000/auth/signup?email=%22%3E%3Cscript%3Ebad%3C%2Fscript%3E&error=%3Cb%3Ebad%3C%2Fb%3E&next=https%3A%2F%2Fexample.com",
    );
    const html = await page.text();

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>bad</b>");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).toContain('action="/auth/signup"');
  });

  test("pins the theme through a cookie and refuses off-site returns", async () => {
    const { app } = await createAuthPageApp();

    const pin = await app.request("http://localhost:3000/auth/theme", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "http://localhost:3000",
      },
      body: formBody({ theme: "dark", next: "/auth/login" }),
    });
    expect(pin.status).toBe(303);
    expect(pin.headers.get("location")).toBe("/auth/login");

    const cookie = pin.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBe("theme=dark");

    const page = await app.request("http://localhost:3000/auth/login", {
      headers: { Cookie: cookie! },
    });
    const html = await page.text();
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain('value="dark" aria-pressed="true"');

    const offSite = await app.request("http://localhost:3000/auth/theme", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "http://localhost:3000",
      },
      body: formBody({ theme: "system", next: "https://example.com" }),
    });
    expect(offSite.headers.get("location")).toBe("/");
    expect(offSite.headers.get("set-cookie")).toContain("theme=;");
  });
});

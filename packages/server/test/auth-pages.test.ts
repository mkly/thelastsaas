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
  options: {
    google?: boolean;
    passwordAuth?: boolean;
    environment?: Record<string, string>;
  } = {},
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
    ...options.environment,
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

function postAuth(
  app: Awaited<ReturnType<typeof createAuthPageApp>>["app"],
  path: string,
  body: Record<string, unknown>,
  cookie = "",
) {
  return app.request(`http://localhost:3000/api/auth/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
}

function formAttribute(
  html: string,
  action: string,
  attribute: string,
): string {
  const form = html.match(
    new RegExp(`<form [^>]*data-auth="${action}"[^>]*>`),
  )?.[0];
  const value = form?.match(new RegExp(` ${attribute}="([^"]*)"`))?.[1];
  if (!value) throw new Error(`Missing ${attribute} on the ${action} form`);
  return value.replaceAll("&amp;", "&");
}

function responseCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

async function cancelGoogle(
  app: Awaited<ReturnType<typeof createAuthPageApp>>["app"],
  html: string,
  oauthQuery?: string,
) {
  const start = await postAuth(app, "sign-in/social", {
    provider: "google",
    callbackURL: formAttribute(html, "google", "data-next"),
    errorCallbackURL: formAttribute(html, "google", "data-error-callback"),
    oauth_query: oauthQuery,
  });
  expect(start.status).toBe(200);
  const google = new URL((await start.json()).url);
  expect(google.origin).toBe("https://accounts.google.com");
  const callback = new URL(google.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", google.searchParams.get("state")!);
  callback.searchParams.set("error", "access_denied");
  const cancelled = await app.request(callback, {
    headers: {
      Cookie: responseCookies(start),
    },
  });
  expect(cancelled.status).toBe(302);
  return new URL(cancelled.headers.get("location")!, callback);
}

async function signUp(
  app: Awaited<ReturnType<typeof createAuthPageApp>>["app"],
  password = "initial-password",
) {
  return postAuth(app, "sign-up/email", {
    name: "Auth User",
    email: "auth-user@example.com",
    password,
  });
}

async function login(
  app: Awaited<ReturnType<typeof createAuthPageApp>>["app"],
  password: string,
) {
  return postAuth(app, "sign-in/email", {
    email: "auth-user@example.com",
    password,
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
    expect(html).toContain('data-auth="magic-link" data-next="/auth/device"');
    const signupPage = await app.request(
      "http://localhost:3000/auth/signup?next=%2Fauth%2Fdevice&email=new%40example.com",
    );
    expect(signupPage.status).toBe(200);
    const signupHtml = await signupPage.text();
    expect(signupHtml).not.toContain('<input type="password"');
    expect(signupHtml).toContain(
      'data-auth="magic-link" data-next="/auth/device"',
    );
    expect(signupHtml).toContain('value="new@example.com"');
    expect(signupHtml.indexOf("Continue with email")).toBeLessThan(
      signupHtml.indexOf("Continue with Google"),
    );
    expect(html.indexOf("Continue with email")).toBeLessThan(
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

    const google = await postAuth(app, "sign-in/social", {
      provider: "google",
      callbackURL: "/auth/dashboard",
    });
    expect(google.status).toBe(200);
    expect((await google.json()).url).toContain("accounts.google.com");
    const magicPage = await app.request(
      "http://localhost:3000/auth/magic-link?next=%2Fauth%2Fdevice",
    );
    expect(await magicPage.text()).toContain(
      'data-auth="magic-link" data-next="/auth/device"',
    );
    await postAuth(app, "sign-in/magic-link", {
      email: "magic-only@example.com",
      callbackURL: "/auth/device",
    });
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
    expect((await login(app, "initial-password")).status).toBe(200);
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
      ["/install", "Install"],
    ]) {
      const response = await app.request(`http://localhost:3000${path}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`<h1>${heading}</h1>`);
      expect(html).toContain('<a href="/install">Install</a>');
    }

    const install = await app.request("http://localhost:3000/install");
    const installHtml = await install.text();
    expect(installHtml).toContain('href="/dl/linux-x64/saas"');
    expect(installHtml).toContain('href="/dl/windows-x64/saas.exe"');
    expect(installHtml).not.toContain("</a> — <code>");
  });

  test("signs up, logs in, renders the dashboard, and logs out", async () => {
    const { app, services } = await createAuthPageApp();

    const signup = await signUp(app);
    expect(signup.status).toBe(200);
    const unverifiedLogin = await login(app, "initial-password");
    expect(unverifiedLogin.status).toBe(403);
    expect(await unverifiedLogin.json()).toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
    });

    await verifyTestUser(services, "auth-user@example.com");
    const loginResponse = await login(app, "initial-password");
    expect(loginResponse.status).toBe(200);
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const dashboard = await app.request(
      "http://localhost:3000/auth/dashboard",
      { headers: { Cookie: cookie! } },
    );
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('<a href="/install">Install</a>');
    /* Log out is an icon in the header, so the name is only in the label. */
    expect(dashboardHtml).toContain('data-auth="logout"');
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
      "/install?message=Browser+Organization+created.+Next%2C+connect+your+assistant.",
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

    const install = await app.request("http://localhost:3000/install", {
      headers: { Cookie: cookie! },
    });
    const installHtml = await install.text();
    expect(installHtml).toContain('data-auth="logout"');
    expect(installHtml).not.toContain('<a href="/auth/login">');
    expect(installHtml).not.toContain('<a href="/auth/signup">');

    const authenticatedRoot = await app.request("http://localhost:3000/", {
      headers: { Cookie: cookie! },
    });
    expect(authenticatedRoot.status).toBe(302);
    expect(authenticatedRoot.headers.get("location")).toBe("/auth/dashboard");

    const logout = await postAuth(app, "sign-out", {}, cookie!);
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("renders browser-based MCP setup instructions", async () => {
    const { app, services } = await createAuthPageApp();
    await signUp(app);
    await verifyTestUser(services, "auth-user@example.com");
    const loginResponse = await login(app, "initial-password");
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const unauthenticated = await app.request("http://localhost:3000/install");
    expect(unauthenticated.status).toBe(200);
    const anonymousHtml = await unauthenticated.text();
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

    const page = await app.request("http://localhost:3000/install", {
      headers: { Cookie: cookie! },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<h1>Install</h1>");
    expect(html).toContain("http://localhost:3000/v1/mcp");
    expect(html).toContain("ChatGPT");
    expect(html).toContain("Claude");
    expect(html).toContain("Add this remote server URL to your assistant.");
    expect(html).not.toContain("session_token");
    expect(html).toContain('aria-current="page">Install</a>');
  });

  test("advertises the MCP resource and authorization server to unauthenticated clients", async () => {
    const { app } = await createAuthPageApp();
    const challengeResponse = await app.request(
      "http://localhost:3000/v1/mcp",
      { method: "POST" },
    );
    expect(challengeResponse.status).toBe(401);
    expect(challengeResponse.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );

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
  });

  test.each(["password", "magic-link", "signup"] as const)(
    "returns an MCP authorization code after %s sign-in and consent",
    async (method) => {
      const { app, services, emails } = await createAuthPageApp({
        passwordAuth: method !== "magic-link",
        google: method !== "magic-link",
      });
      let cookie: string | undefined;
      if (method === "password") {
        await signUp(app);
        await verifyTestUser(services, "auth-user@example.com");
        const loginResponse = await login(app, "initial-password");
        cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
        expect(cookie).toBeTruthy();
      }

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
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
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

      if (method === "magic-link") {
        for (const [name, value] of [
          ["prompt", "login"],
          ["max_age", "0"],
        ] as const) {
          const fresh = new URL(authorize);
          fresh.searchParams.set(name, value);
          const challenged = await app.request(fresh);
          expect(challenged.status).toBe(302);
          const login = new URL(challenged.headers.get("location")!, fresh);
          const page = await app.request(login);
          const html = await page.text();
          expect(html).toContain("This client requires a fresh sign-in");
          expect(html).not.toContain('data-auth="magic-link"');
          expect(html).not.toContain('data-auth="google"');
          expect(emails).toHaveLength(0);
        }
      }
      if (method !== "magic-link")
        authorize.searchParams.set("prompt", "login");
      const start = await app.request(authorize, {
        headers: { Cookie: cookie ?? "" },
      });
      expect(start.status).toBe(302);
      const loginUrl = new URL(start.headers.get("location")!, authorize);
      expect(loginUrl.pathname).toBe("/auth/login");
      const loginPage = await app.request(loginUrl, {
        headers: { Cookie: cookie ?? "" },
      });
      expect(loginPage.status).toBe(200);
      const loginHtml = await loginPage.text();
      const callbackURL = formAttribute(
        loginHtml,
        method === "magic-link" ? "magic-link" : "login",
        "data-next",
      );
      const oauthQuery = loginUrl.searchParams.toString();
      expect(loginUrl.searchParams.get("sig")).toBeTruthy();
      let consentLocation: string;
      if (method === "password") {
        // A cancellation must leave the signed request usable for another sign-in method.
        const retry = await cancelGoogle(app, loginHtml, oauthQuery);
        expect(retry.pathname).toBe("/auth/login");
        expect(retry.searchParams.get("error")).toBe("access_denied");
        const retryPage = await app.request(retry, {
          headers: { Cookie: cookie! },
        });
        expect(retryPage.status).toBe(200);
        expect(
          formAttribute(await retryPage.text(), "login", "data-next"),
        ).toBe(callbackURL);
        const signedIn = await postAuth(
          app,
          "sign-in/email",
          {
            email: "auth-user@example.com",
            password: "initial-password",
            callbackURL,
            oauth_query: oauthQuery,
          },
          cookie,
        );
        expect(signedIn.status).toBe(200);
        const result = await signedIn.json();
        expect(result.redirect).toBe(true);
        consentLocation = result.url;
        cookie = responseCookies(signedIn);
      } else {
        const email = "magic-oauth@example.com";
        if (method === "magic-link") {
          const sent = await postAuth(app, "sign-in/magic-link", {
            email,
            callbackURL,
            oauth_query: oauthQuery,
          });
          expect(sent.status).toBe(200);
        } else {
          const signupPath = loginHtml
            .match(/href="([^"]+)">Sign up</)?.[1]
            ?.replaceAll("&amp;", "&");
          const signup = new URL(signupPath!, loginUrl);
          expect(signup.search).toBe(loginUrl.search);
          const signupPage = await app.request(signup);
          expect(
            formAttribute(await signupPage.text(), "signup", "data-next"),
          ).toBe(callbackURL);
          const signedUp = await postAuth(app, "sign-up/email", {
            email,
            name: "OAuth Signup",
            password: "initial-password",
            callbackURL,
            oauth_query: oauthQuery,
          });
          expect(signedUp.status).toBe(200);
        }
        const mail = emails.find((mail) => mail.to === email)!;
        expect(mail.type).toBe(
          method === "magic-link" ? "magic-link" : "email-verification",
        );
        const authContext = await services.auth.$context;
        authContext.skipOriginCheck = false;
        if (method === "magic-link") {
          const externalCallback = new URL(mail.url);
          expect(externalCallback.searchParams.get("callbackURL")).toBe(
            callbackURL,
          );
          externalCallback.searchParams.set(
            "callbackURL",
            "https://untrusted.example/callback",
          );
          const rejected = await app.request(externalCallback);
          expect(rejected.status).toBe(403);
          expect(await rejected.json()).toMatchObject({
            code: "INVALID_CALLBACK_URL",
          });
        }
        // The verification link opens as a navigation in a fresh browser.
        const verified = await app.request(mail.url, {
          headers: { Accept: "text/html" },
        });
        expect(verified.status).toBe(302);
        cookie = responseCookies(verified);
        const continuation = new URL(
          verified.headers.get("location")!,
          loginUrl,
        );
        expect(continuation.href).toBe(new URL(callbackURL, loginUrl).href);
        const resumed = await app.request(continuation, {
          headers: { Cookie: cookie },
        });
        expect(resumed.status).toBe(302);
        consentLocation = resumed.headers.get("location")!;
        if (method === "signup") {
          // Verification completed signup. The client still requires a password sign-in.
          const freshLogin = new URL(consentLocation, loginUrl);
          expect(freshLogin.pathname).toBe("/auth/login");
          const page = await app.request(freshLogin, {
            headers: { Cookie: cookie },
          });
          expect(page.status).toBe(200);
          const signedIn = await postAuth(
            app,
            "sign-in/email",
            {
              email,
              password: "initial-password",
              callbackURL: formAttribute(
                await page.text(),
                "login",
                "data-next",
              ),
              oauth_query: freshLogin.searchParams.toString(),
            },
            cookie,
          );
          expect(signedIn.status).toBe(200);
          consentLocation = (await signedIn.json()).url;
          cookie = responseCookies(signedIn);
        }
      }
      expect(cookie).toContain("session_token");
      const created = await app.request("http://localhost:3000/v1/orgs", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "OAuth Org", slug: "oauth-org" }),
      });
      expect(created.status).toBe(201);
      expect(consentLocation).toStartWith("/auth/mcp/consent?");
      const consentQuery = new URL(
        consentLocation!,
        "http://localhost:3000",
      ).searchParams.toString();

      const consentUrl = new URL(consentLocation!, "http://localhost:3000");
      consentUrl.searchParams.set("page", "test");
      const consentPage = await app.request(consentUrl, {
        headers: { Cookie: cookie! },
      });
      expect(consentPage.status).toBe(200);
      const consentHtml = await consentPage.text();
      expect(consentHtml).toContain("OAuth Test Client");
      expect(consentHtml).toContain("client.example");

      const changedRequest = new URLSearchParams(consentQuery);
      changedRequest.set("state", "changed-after-signing");
      consentUrl.search = changedRequest.toString();
      const invalidPage = await app.request(consentUrl, {
        headers: { Cookie: cookie! },
      });
      expect(invalidPage.status).toBe(400);
      expect(await invalidPage.text()).not.toContain('data-auth="consent"');
      const invalid = await postAuth(
        app,
        "oauth2/consent",
        {
          accept: true,
          oauth_query: changedRequest.toString(),
        },
        cookie,
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: "invalid_signature",
      });

      const consent = await postAuth(
        app,
        "oauth2/consent",
        { accept: true, oauth_query: consentQuery },
        cookie!,
      );
      expect(consent.status).toBe(200);
      const grant = await consent.json();
      expect(grant.redirect).toBe(true);
      const callback = new URL(grant.url);
      expect(callback.origin).toBe("https://client.example");
      expect(callback.searchParams.get("state")).toBe("oauth-test-state");
      expect(callback.searchParams.get("code")).toBeTruthy();
    },
  );

  test("sends and verifies a magic link without revealing unknown users", async () => {
    const { app, emails } = await createAuthPageApp();
    await signUp(app);

    const sent = await postAuth(app, "sign-in/magic-link", {
      email: "auth-user@example.com",
      callbackURL: "/auth/dashboard",
    });
    expect(sent.status).toBe(200);
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

    const requested = await postAuth(app, "request-password-reset", {
      email: "auth-user@example.com",
      redirectTo: "/auth/reset-password",
    });
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

    const reset = await postAuth(app, "reset-password", {
      token: token!,
      newPassword: "replacement-password",
    });
    expect(reset.status).toBe(200);
    expect((await login(app, "initial-password")).status).toBe(401);
    expect((await login(app, "replacement-password")).status).toBe(200);
  });

  test("renders configured Google OAuth links and preserves a safe auth next path", async () => {
    const { app } = await createAuthPageApp({ google: true });

    const loginPage = await app.request("http://localhost:3000/auth/login");
    expect(await loginPage.text()).toContain("Continue with Google");

    const signupPage = await app.request(
      "http://localhost:3000/auth/signup?next=%2Fauth%2Fdevice%2Fauthorize%3Fstate%3Dcli",
    );
    const signupHtml = await signupPage.text();
    expect(signupHtml).toContain(
      'data-auth="google" data-next="/auth/device/authorize?state=cli"',
    );

    const retry = await cancelGoogle(app, signupHtml);
    expect(retry.pathname).toBe("/auth/login");
    expect(retry.searchParams.get("error")).toBe("access_denied");
    expect(retry.searchParams.get("next")).toBe(
      "/auth/device/authorize?state=cli",
    );
    const retryHtml = await (await app.request(retry)).text();
    expect(formAttribute(retryHtml, "google", "data-next")).toBe(
      "/auth/device/authorize?state=cli",
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

    const unavailable = await postAuth(appWithoutGoogle, "sign-in/social", {
      provider: "google",
      callbackURL: "/auth/dashboard",
    });
    expect(unavailable.ok).toBe(false);
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

    const authorization = await postAuth(app, "sign-in/social", {
      provider: "google",
      callbackURL: "/auth/dashboard",
    });
    const authorizationUrl = new URL((await authorization.json()).url);
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
    expect(html).toContain('data-auth="signup" data-next="/auth/dashboard"');
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

describe("public authentication protections", () => {
  test("rejects cross-origin email requests before delivery", async () => {
    const { app, services, emails } = await createAuthPageApp();
    const context = await services.auth.$context;
    context.skipOriginCheck = false;
    const response = await app.request(
      "http://localhost:3000/api/auth/sign-in/magic-link",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://untrusted.example",
        },
        body: JSON.stringify({ email: "target@example.com" }),
      },
    );
    expect(response.status).toBe(403);
    expect(emails).toHaveLength(0);
  });

  test("removes every legacy submission path without sending email or creating accounts", async () => {
    const { app, emails, services } = await createAuthPageApp();
    for (const path of [
      "login",
      "signup",
      "magic-link",
      "forgot-password",
      "reset-password",
      "device/approve",
      "device/deny",
      "mcp/consent",
      "invitations/test",
    ]) {
      const response = await app.request(`http://localhost:3000/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost:3000",
        },
        body: formBody({
          email: "bypass@example.com",
          name: "Bypass",
          password: "test-password",
        }),
      });
      expect(response.status).toBe(404);
    }
    expect(
      (await app.request("http://localhost:3000/auth/google")).status,
    ).toBe(404);
    expect(
      (await app.request("http://localhost:3000/auth/logout")).status,
    ).toBe(404);
    expect(emails).toHaveLength(0);
    expect(await services.prisma.user.count()).toBe(0);
  });

  test("enforces Better Auth's per-IP magic-link limit before email delivery", async () => {
    const { app, emails } = await createAuthPageApp({
      environment: { AUTH_RATE_LIMIT_ENABLED: "true" },
    });
    const send = (ip: string, spoofed = "198.51.100.1") =>
      app.request("http://localhost:3000/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          "x-lastsaas-client-ip": ip,
          "x-forwarded-for": spoofed,
        },
        body: JSON.stringify({ email: "limit@example.com" }),
      });
    for (let i = 0; i < 5; i++)
      expect((await send("192.0.2.71")).status).toBe(200);
    const limited = await send("192.0.2.71", "198.51.100.2");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-retry-after")).toBeTruthy();
    expect(emails).toHaveLength(5);
    expect((await send("192.0.2.72")).status).toBe(200);
    expect(emails).toHaveLength(6);
  });

  test("checks CAPTCHA on all public email send endpoints and fails closed", async () => {
    const { app, emails, services } = await createAuthPageApp({
      environment: {
        TURNSTILE_SITE_KEY: "public-widget-key",
        TURNSTILE_SECRET_KEY: "private-widget-key",
      },
    });
    const page = await (
      await app.request("http://localhost:3000/auth/login")
    ).text();
    expect(page).toContain('data-captcha-site-key="public-widget-key"');
    expect(page).not.toContain("private-widget-key");
    expect(page).toContain("/assets/auth.js");
    for (const path of [
      "sign-in/magic-link",
      "sign-up/email",
      "sign-in/email",
      "request-password-reset",
      "send-verification-email",
    ]) {
      const response = await postAuth(app, path, {
        email: "protected@example.com",
        name: "Protected",
        password: "test-password",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "MISSING_RESPONSE" });
    }
    expect(emails).toHaveLength(0);
    expect(await services.prisma.user.count()).toBe(0);

    const originalFetch = globalThis.fetch;
    let verification: Record<string, unknown> = { success: false };
    let unavailable = false;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        secret: "private-widget-key",
        response: "widget-response",
      });
      if (unavailable) return new Response("unavailable", { status: 503 });
      return Response.json(verification);
    }) as typeof fetch;
    const send = () =>
      app.request("http://localhost:3000/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          "x-captcha-response": "widget-response",
        },
        body: JSON.stringify({
          email: "protected@example.com",
          callbackURL: "/auth/dashboard",
        }),
      });
    try {
      expect((await send()).status).toBe(403);
      verification = { success: true, action: "wrong", hostname: "localhost" };
      expect((await send()).status).toBe(403);
      verification = {
        success: true,
        action: "auth",
        hostname: "wrong.example",
      };
      expect((await send()).status).toBe(403);
      unavailable = true;
      expect((await send()).status).toBe(500);
      expect(emails).toHaveLength(0);
      unavailable = false;
      verification = { success: true, action: "auth", hostname: "localhost" };
      expect((await send()).status).toBe(200);
      expect(emails).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Opening a valid emailed link needs no second CAPTCHA challenge.
    const verified = await app.request(emails[0]!.url);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("set-cookie")).toContain("session_token");
  });
});

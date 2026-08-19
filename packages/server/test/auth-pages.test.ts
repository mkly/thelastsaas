import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import type { AuthEmail } from "../src/auth";
import { loadConfig } from "../src/config";
import { closeServices, createServices } from "../src/services";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260819015000_init/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createAuthPageApp(options: { google?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-auth-pages-"));
  const emails: AuthEmail[] = [];
  const config = loadConfig({
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
  services.database.exec(migration);
  const app = createApp({ config, services });
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, emails };
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
    const { app } = await createAuthPageApp();

    const signup = await signUp(app);
    expect(signup.status).toBe(302);
    expect(signup.headers.get("location")).toBe(
      "/auth/login?message=Account+created.+Please+log+in.",
    );

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
    expect(dashboardHtml).toContain('<a href="/auth/logout">Log Out</a>');
    expect(dashboardHtml).not.toContain('<a href="/auth/login">');
    expect(dashboardHtml).not.toContain('<a href="/auth/signup">');
    expect(dashboardHtml).toContain("auth-user@example.com");
    expect(dashboardHtml).toContain("No organizations yet");

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
    expect(installHtml).toContain('<a href="/auth/logout">Log Out</a>');
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

  test("sends and verifies a magic link without revealing unknown users", async () => {
    const { app, emails } = await createAuthPageApp();
    await signUp(app);

    const sent = await app.request("http://localhost:3000/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ email: "auth-user@example.com" }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain("If an account exists");
    const email = emails.find((candidate) => candidate.type === "magic-link");
    expect(email?.to).toBe("auth-user@example.com");

    const verified = await app.request(email!.url);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toContain("/auth/dashboard");
    expect(verified.headers.get("set-cookie")).toBeTruthy();
  });

  test("completes password reset and accepts only the new password", async () => {
    const { app, emails } = await createAuthPageApp();
    await signUp(app);

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

  test("starts configured Google OAuth and preserves a safe auth next path", async () => {
    const { app } = await createAuthPageApp({ google: true });

    const loginPage = await app.request("http://localhost:3000/auth/login");
    expect(await loginPage.text()).toContain("Continue with Google");

    const response = await app.request(
      "http://localhost:3000/auth/google?next=%2Fauth%2Fdevice%2Fauthorize%3Fstate%3Dcli",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith(
      "https://accounts.google.com/",
    );
    expect(response.headers.get("set-cookie")).toBeTruthy();
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

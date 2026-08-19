import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { AppEnvironment } from "../src/env";
import { createAuthMiddleware } from "../src/middleware/auth";
import {
  computeS256Challenge,
  deviceAuthRouter,
  isLoopbackRedirectUri,
} from "../src/routes/device-auth";

const RFC_7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

interface StoredAuthCode {
  id: string;
  code: string;
  codeChallenge: string;
  redirectUri: string;
  userId: string | null;
  expiresAt: Date;
  used: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface CodeCreateArgs {
  data: {
    id: string;
    code: string;
    codeChallenge: string;
    redirectUri: string;
    expiresAt: Date;
  };
}

interface CodeUpdateArgs {
  where: {
    code: string;
    userId?: string | null;
    used?: boolean;
    expiresAt?: { gt: Date };
  };
  data: { used?: boolean; userId?: string };
}

interface SessionCreateArgs {
  data: {
    id: string;
    userId: string;
    token: string;
    expiresAt: Date;
    activeOrganizationId: string | null;
    userAgent: string;
    ipAddress: string | null;
  };
}

interface FakePrisma {
  deviceAuthCode: {
    create(args: CodeCreateArgs): Promise<StoredAuthCode>;
    findUnique(args: {
      where: { code: string };
    }): Promise<StoredAuthCode | null>;
    updateMany(args: CodeUpdateArgs): Promise<{ count: number }>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  session: {
    create(args: SessionCreateArgs): Promise<SessionCreateArgs["data"]>;
    findUnique(args: { where: { token: string } }): Promise<{
      id: string;
      expiresAt: Date;
      user: { id: string; name: string };
    } | null>;
  };
  user: {
    findUnique(args: unknown): Promise<{ id: string; name: string } | null>;
  };
  member: {
    findFirst(args: unknown): Promise<{ organizationId: string }>;
    findUnique(args: unknown): Promise<{ id: string }>;
  };
  $transaction<T>(
    operation: (transaction: FakePrisma) => Promise<T>,
  ): Promise<T>;
}

function createFlowHarness() {
  const user = {
    id: "user_device",
    name: "Device User",
    email: "device-user@example.com",
  };
  let authCode: StoredAuthCode | null = null;
  let storedSession: SessionCreateArgs["data"] | null = null;
  let browserSessionLookups = 0;

  const prisma: FakePrisma = {
    deviceAuthCode: {
      async create({ data }) {
        const now = new Date();
        authCode = {
          ...data,
          userId: null,
          used: false,
          createdAt: now,
          updatedAt: now,
        };
        return authCode;
      },
      async findUnique({ where }) {
        return authCode?.code === where.code ? authCode : null;
      },
      async updateMany({ where, data }) {
        if (
          !authCode ||
          authCode.code !== where.code ||
          (where.userId !== undefined && authCode.userId !== where.userId) ||
          (where.used !== undefined && authCode.used !== where.used) ||
          (where.expiresAt?.gt && authCode.expiresAt <= where.expiresAt.gt)
        ) {
          return { count: 0 };
        }
        if (data.userId !== undefined) authCode.userId = data.userId;
        if (data.used !== undefined) authCode.used = data.used;
        authCode.updatedAt = new Date();
        return { count: 1 };
      },
      async deleteMany(_args) {
        return { count: 0 };
      },
    },
    session: {
      async create({ data }) {
        storedSession = data;
        return data;
      },
      async findUnique({ where }) {
        if (!storedSession || storedSession.token !== where.token) return null;
        return {
          id: storedSession.id,
          expiresAt: storedSession.expiresAt,
          user: { id: user.id, name: user.name },
        };
      },
    },
    user: {
      async findUnique(_args) {
        return { id: user.id, name: user.name };
      },
    },
    member: {
      async findFirst(_args) {
        return { organizationId: "org_device" };
      },
      async findUnique(_args) {
        return { id: "member_device" };
      },
    },
    async $transaction(operation) {
      return operation(prisma);
    },
  };

  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        browserSessionLookups += 1;
        return headers.get("x-browser-session") === "active"
          ? { session: { id: "browser_session" }, user }
          : null;
      },
    },
  };
  const app = new Hono<AppEnvironment>();
  app.use("*", async (context, next) => {
    context.set("services", { auth, prisma } as never);
    await next();
  });
  app.route("/auth/device", deviceAuthRouter);

  return {
    app,
    auth,
    prisma,
    user,
    authCode: () => authCode,
    storedSession: () => storedSession,
    browserSessionLookups: () => browserSessionLookups,
  };
}

describe("PKCE helpers", () => {
  test("computes the RFC 7636 S256 challenge", async () => {
    expect(await computeS256Challenge(RFC_7636_VERIFIER)).toBe(
      RFC_7636_CHALLENGE,
    );
  });

  test("accepts HTTP loopback callbacks and rejects unsafe redirects", () => {
    expect(isLoopbackRedirectUri("http://localhost:12345/callback")).toBe(true);
    expect(isLoopbackRedirectUri("http://127.0.0.1:8080/callback")).toBe(true);
    expect(isLoopbackRedirectUri("http://[::1]:8080/callback")).toBe(true);
    expect(isLoopbackRedirectUri("https://localhost:12345/callback")).toBe(
      false,
    );
    expect(isLoopbackRedirectUri("http://example.com/callback")).toBe(false);
    expect(isLoopbackRedirectUri("not-a-url")).toBe(false);
  });
});

describe("device authorization flow", () => {
  test("redirects an unauthenticated browser to login with the flow intact", async () => {
    const harness = createFlowHarness();
    const redirectUri = "http://127.0.0.1:41234/callback";
    const query = new URLSearchParams({
      code_challenge: RFC_7636_CHALLENGE,
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      state: "state-value",
    });

    const response = await harness.app.request(
      `/auth/device/authorize?${query.toString()}`,
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toStartWith("/auth/login?next=");
    const next = new URL(location!, "http://lastsaas.example").searchParams.get(
      "next",
    );
    expect(next).toContain("/auth/device/authorize?");
    expect(next).toContain("state=state-value");
  });

  test("issues, approves, exchanges, and authenticates an lst_ session", async () => {
    const harness = createFlowHarness();
    const redirectUri = "http://127.0.0.1:41234/callback";
    const state = "state-value";
    const query = new URLSearchParams({
      code_challenge: RFC_7636_CHALLENGE,
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      state,
    });
    const browserHeaders = { "x-browser-session": "active" };

    const authorize = await harness.app.request(
      `/auth/device/authorize?${query.toString()}`,
      { headers: browserHeaders },
    );
    expect(authorize.status).toBe(200);
    expect(await authorize.text()).toContain("Authorize CLI");
    const code = harness.authCode()?.code;
    if (!code) throw new Error("authorization code was not created");

    const tokenPayload = {
      code,
      code_verifier: RFC_7636_VERIFIER,
      redirect_uri: redirectUri,
    };
    const pending = await harness.app.request("/auth/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokenPayload),
    });
    expect(pending.status).toBe(400);
    expect(await pending.json()).toEqual({
      status: "error",
      error: "authorization_pending",
    });

    const forged = await harness.app.request("/auth/device/authorize", {
      method: "POST",
      headers: {
        ...browserHeaders,
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://attacker.example",
      },
      body: new URLSearchParams({ code, state }),
    });
    expect(forged.status).toBe(403);
    expect(harness.authCode()?.userId).toBe(null);

    const approval = await harness.app.request("/auth/device/authorize", {
      method: "POST",
      headers: {
        ...browserHeaders,
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
      },
      body: new URLSearchParams({ code, state }),
    });
    expect(approval.status).toBe(302);
    const callback = new URL(approval.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("code")).toBe(code);
    expect(callback.searchParams.get("state")).toBe(state);

    const exchange = await harness.app.request("/auth/device/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.10, 198.51.100.4",
      },
      body: JSON.stringify(tokenPayload),
    });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json()) as {
      status: string;
      session_token: string;
      expires_at: string;
    };
    expect(token.status).toBe("ok");
    expect(token.session_token).toStartWith("lst_");
    const storedSession = harness.storedSession();
    if (!storedSession) throw new Error("CLI session was not created");
    expect(token.session_token.slice(4)).toBe(storedSession.token);
    expect(storedSession.ipAddress).toBe("192.0.2.10");
    expect(storedSession.activeOrganizationId).toBeNull();

    const browserLookupsBeforeCliRequest = harness.browserSessionLookups();
    const protectedApp = new Hono<AppEnvironment>();
    protectedApp.use(
      "/v1/orgs/:orgId/*",
      createAuthMiddleware({
        auth: harness.auth,
        prisma: harness.prisma,
      } as never),
    );
    protectedApp.get("/v1/orgs/:orgId/probe", (context) =>
      context.json({
        orgId: context.get("orgId"),
        userId: context.get("userId"),
      }),
    );

    const authenticated = await protectedApp.request(
      "/v1/orgs/org_device/probe",
      { headers: { authorization: `Bearer ${token.session_token}` } },
    );
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual({
      orgId: "org_device",
      userId: harness.user.id,
    });
    expect(harness.browserSessionLookups()).toBe(
      browserLookupsBeforeCliRequest,
    );

    const replay = await harness.app.request("/auth/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokenPayload),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({
      status: "error",
      error: "Code already used",
    });
  });
});

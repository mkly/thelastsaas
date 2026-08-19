import type { PrismaClient } from "@prisma/client";
import { genId } from "@lastsaas/shared";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";

import { SESSION_EXPIRES_IN_SECONDS } from "../auth";
import { bootstrapOrgPolicies } from "../db/casbin";
import { ensurePersonalOrganization } from "../db/organizations";
import type { AppEnvironment } from "../env";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const USED_CODE_RETENTION_MS = 60 * 60 * 1000;
const PKCE_VALUE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

interface TokenRequest {
  code: string;
  code_verifier: string;
  redirect_uri: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} - Last SaaS</title>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      ${body}
    </main>
  </body>
</html>`;
}

function deviceError(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTokenRequest(value: unknown): TokenRequest | null {
  if (!isRecord(value)) return null;
  const code = value.code;
  const codeVerifier = value.code_verifier;
  const redirectUri = value.redirect_uri;
  if (
    typeof code !== "string" ||
    !code ||
    typeof codeVerifier !== "string" ||
    !codeVerifier ||
    typeof redirectUri !== "string" ||
    !redirectUri
  ) {
    return null;
  }
  return {
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  };
}

export function isLoopbackRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export async function computeS256Challenge(
  codeVerifier: string,
): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(hash).toString("base64url");
}

async function createCliSession(
  prisma: PrismaClient,
  authCode: {
    code: string;
    userId: string;
  },
  orgId: string,
  ipAddress: string | null,
): Promise<{ expiresAt: Date; sessionToken: string } | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_EXPIRES_IN_SECONDS * 1000);
  const sessionToken = randomToken();
  const created = await prisma.$transaction(async (transaction) => {
    const claimed = await transaction.deviceAuthCode.updateMany({
      where: {
        code: authCode.code,
        userId: authCode.userId,
        used: false,
        expiresAt: { gt: now },
      },
      data: { used: true },
    });
    if (claimed.count !== 1) return false;

    await transaction.session.create({
      data: {
        id: genId(),
        userId: authCode.userId,
        token: sessionToken,
        expiresAt,
        activeOrganizationId: orgId,
        userAgent: "lastsaas-cli",
        ipAddress,
      },
    });
    await transaction.deviceAuthCode.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: now } },
          {
            used: true,
            createdAt: {
              lt: new Date(now.getTime() - USED_CODE_RETENTION_MS),
            },
          },
        ],
      },
    });
    return true;
  });

  return created ? { expiresAt, sessionToken } : null;
}

export const deviceAuthRouter = new Hono<AppEnvironment>();

deviceAuthRouter.get("/authorize", async (context) => {
  const codeChallenge = context.req.query("code_challenge");
  const codeChallengeMethod = context.req.query("code_challenge_method");
  const redirectUri = context.req.query("redirect_uri");
  const state = context.req.query("state") ?? "";

  if (!codeChallenge || !redirectUri) {
    return context.json(
      deviceError("Missing code_challenge or redirect_uri"),
      400,
    );
  }
  if (!PKCE_VALUE_PATTERN.test(codeChallenge)) {
    return context.json(deviceError("Invalid code_challenge"), 400);
  }
  if (codeChallengeMethod !== "S256") {
    return context.json(
      deviceError("Only S256 code_challenge_method is supported"),
      400,
    );
  }
  if (!isLoopbackRedirectUri(redirectUri)) {
    return context.json(
      deviceError("redirect_uri must be an HTTP loopback URL"),
      400,
    );
  }

  const { auth, prisma } = context.get("services");
  const session = await auth.api
    .getSession({ headers: context.req.raw.headers })
    .catch(() => null);
  if (!session?.user) {
    const params = new URLSearchParams({
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
    });
    if (state) params.set("state", state);
    const next = `/auth/device/authorize?${params.toString()}`;
    return context.redirect(`/auth/login?next=${encodeURIComponent(next)}`);
  }

  const code = randomToken();
  await prisma.deviceAuthCode.create({
    data: {
      id: genId(),
      code,
      codeChallenge,
      redirectUri,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    },
  });

  return context.html(
    htmlPage(
      "Authorize CLI",
      `<p>The Last SaaS CLI is requesting access to your account as <strong>${escapeHtml(session.user.name)}</strong> (${escapeHtml(session.user.email)}).</p>
      <form method="post" action="/auth/device/authorize">
        <input type="hidden" name="code" value="${escapeHtml(code)}">
        <input type="hidden" name="state" value="${escapeHtml(state)}">
        <button type="submit">Approve</button>
      </form>
      <p><a href="/auth/login">Cancel</a></p>`,
    ),
  );
});

deviceAuthRouter.post("/authorize", async (context) => {
  const { auth, prisma } = context.get("services");
  const session = await auth.api
    .getSession({ headers: context.req.raw.headers })
    .catch(() => null);
  if (!session?.user) {
    return context.json(deviceError("Not authenticated"), 401);
  }

  const form = await context.req.parseBody();
  const code = typeof form.code === "string" ? form.code : "";
  const state = typeof form.state === "string" ? form.state : "";
  const authCode = code
    ? await prisma.deviceAuthCode.findUnique({ where: { code } })
    : null;
  const now = new Date();
  if (!authCode || authCode.used || authCode.expiresAt <= now) {
    return context.html(
      htmlPage(
        "Error",
        "<p>Invalid or expired authorization request. Please try again from the CLI.</p>",
      ),
      400,
    );
  }

  const approved = await prisma.deviceAuthCode.updateMany({
    where: {
      code,
      userId: null,
      used: false,
      expiresAt: { gt: now },
    },
    data: { userId: session.user.id },
  });
  if (approved.count !== 1) {
    return context.html(
      htmlPage(
        "Error",
        "<p>This authorization request has already been approved or expired.</p>",
      ),
      400,
    );
  }

  const redirectUrl = new URL(authCode.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  return context.redirect(redirectUrl.toString());
});

deviceAuthRouter.post("/token", async (context) => {
  const body = await context.req.json<unknown>().catch(() => null);
  const request = parseTokenRequest(body);
  if (!request) {
    return context.json(
      deviceError("Missing code, code_verifier, or redirect_uri"),
      400,
    );
  }
  if (!PKCE_VALUE_PATTERN.test(request.code_verifier)) {
    return context.json(deviceError("Invalid code_verifier"), 400);
  }

  const { auth, prisma } = context.get("services");
  const authCode = await prisma.deviceAuthCode.findUnique({
    where: { code: request.code },
  });
  if (!authCode) {
    return context.json(deviceError("Invalid code"), 400);
  }
  if (authCode.used) {
    return context.json(deviceError("Code already used"), 400);
  }
  if (authCode.expiresAt <= new Date()) {
    return context.json(deviceError("Code expired"), 400);
  }
  if (authCode.redirectUri !== request.redirect_uri) {
    return context.json(deviceError("redirect_uri mismatch"), 400);
  }
  if (!authCode.userId) {
    return context.json(deviceError("authorization_pending"), 400);
  }

  const expectedChallenge = await computeS256Challenge(request.code_verifier);
  if (expectedChallenge !== authCode.codeChallenge) {
    return context.json(deviceError("Invalid code_verifier"), 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: authCode.userId },
    select: { id: true, name: true },
  });
  if (!user) {
    return context.json(deviceError("Authorized user no longer exists"), 400);
  }

  const personalOrganization = await ensurePersonalOrganization(
    prisma,
    auth,
    user,
  );
  if (personalOrganization.created) {
    await bootstrapOrgPolicies(prisma, personalOrganization.orgId, user.id);
  }

  const forwardedFor = context.req.header("x-forwarded-for")?.split(",")[0];
  const cliSession = await createCliSession(
    prisma,
    { code: authCode.code, userId: authCode.userId },
    personalOrganization.orgId,
    forwardedFor?.trim() || context.req.header("x-real-ip") || null,
  );
  if (!cliSession) {
    return context.json(deviceError("Code already used"), 400);
  }

  return context.json({
    status: "ok" as const,
    session_token: `lst_${cliSession.sessionToken}`,
    expires_at: cliSession.expiresAt.toISOString(),
  });
});

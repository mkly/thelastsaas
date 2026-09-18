import { apiKey } from "@better-auth/api-key";
import { mcp } from "@better-auth/mcp";
import type { PrismaClient } from "@prisma/client";
import { genId } from "@lastsaas/shared";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import {
  bearer,
  deviceAuthorization,
  jwt,
  magicLink,
  organization,
} from "better-auth/plugins";

import { databaseProvider, type AppConfig } from "./config";
import { log } from "./logger";
import { createAuditWriter } from "./db/audit";
import {
  applyInvitationPermissions,
  validateInvitationPermissions,
} from "./invitation-permissions";

export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 90;
const SESSION_UPDATE_AGE = 60 * 60 * 24;
export const MCP_TOOLS_SCOPE = "mcp:tools";
export const MCP_ACCOUNT_CLAIM =
  "https://thelastsaas.com/claims/account_access";

export function mcpResourceUrl(config: AppConfig): string {
  return new URL("/v1/mcp", config.betterAuthUrl).toString();
}

export interface AuthEmail {
  type: "magic-link" | "password-reset" | "email-verification" | "invitation";
  to: string;
  url: string;
}

export type AuthEmailSender = (email: AuthEmail) => Promise<void>;

const logAuthEmail: AuthEmailSender = async ({ type, to, url }) => {
  log.info(`auth:${type}`, `${to}: ${url}`);
};

export function createAuth(
  prisma: PrismaClient,
  config: AppConfig,
  sendAuthEmail: AuthEmailSender = logAuthEmail,
) {
  const mcpResource = mcpResourceUrl(config);
  const permitsInteractiveAuth = async (userId: string) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { kind: true },
    });
    return user?.kind !== "service";
  };

  return betterAuth({
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthUrl,
    database: prismaAdapter(prisma, {
      provider: databaseProvider(config.databaseUrl),
    }),
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE,
    },
    user: {
      additionalFields: {
        kind: {
          type: "string",
          input: false,
          defaultValue: "human",
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => permitsInteractiveAuth(session.userId),
        },
      },
      account: {
        create: {
          before: async (account) => permitsInteractiveAuth(account.userId),
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (
          !config.passwordAuthEnabled &&
          ([
            "/sign-in/email",
            "/sign-up/email",
            "/request-password-reset",
            "/reset-password",
            "/change-password",
            "/verify-password",
          ].includes(context.path) ||
            context.path?.startsWith("/reset-password/"))
        ) {
          throw new APIError("FORBIDDEN", {
            code: "PASSWORD_AUTH_DISABLED",
            message: "Password authentication is disabled",
          });
        }
      }),
    },
    emailAndPassword: {
      enabled: config.passwordAuthEnabled,
      minPasswordLength: 8,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await sendAuthEmail({ type: "password-reset", to: user.email, url });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAuthEmail({
          type: "email-verification",
          to: user.email,
          url,
        });
      },
    },
    account: {
      accountLinking: {
        trustedProviders: ["google"],
        // Google verifies the email on its side, so an unverified local
        // password account with the same address may still link. Trades the
        // pre-registration takeover guard for smoother sign-in.
        requireLocalEmailVerified: false,
      },
    },
    socialProviders:
      config.googleClientId && config.googleClientSecret
        ? {
            google: {
              clientId: config.googleClientId,
              clientSecret: config.googleClientSecret,
            },
          }
        : {},
    plugins: [
      apiKey({
        enableMetadata: true,
        enableSessionForAPIKeys: true,
        rateLimit: { enabled: false },
      }),
      bearer(),
      jwt(),
      mcp({
        resource: mcpResource,
        loginPage: "/auth/login",
        consentPage: "/auth/mcp/consent",
        scopes: ["openid", "profile", "offline_access", MCP_TOOLS_SCOPE],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Organization-specific grants cannot acquire account access on refresh.
        customAccessTokenClaims: ({ referenceId }) =>
          referenceId ? {} : { [MCP_ACCOUNT_CLAIM]: true },
      }),
      deviceAuthorization({
        verificationUri: "/auth/device",
        schema: {},
      }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          const link = new URL(url);
          // TODO: Once https://github.com/better-auth/better-auth/pull/11174
          // is merged and released, upgrade Better Auth and remove this extra
          // encoding together. Keep the magic-link MCP OAuth regression test.
          // Better Auth 1.7.1 decodes these values again after query parsing
          // (https://github.com/better-auth/better-auth/issues/10916).
          // Preserve nested OAuth parameters (including their signature) through
          // that extra decode. Origin validation still checks the original URL.
          for (const key of [
            "callbackURL",
            "newUserCallbackURL",
            "errorCallbackURL",
          ]) {
            const callback = link.searchParams.get(key);
            if (callback)
              link.searchParams.set(key, encodeURIComponent(callback));
          }
          await sendAuthEmail({
            type: "magic-link",
            to: email,
            url: link.toString(),
          });
        },
      }),
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: "admin",
        // Last SaaS generates opaque UUIDv7 invitation IDs. Better Auth cannot
        // infer that from a custom generator, so preserve the emailed-link flow.
        requireEmailVerificationOnInvitation: false,
        schema: {
          invitation: {
            additionalFields: {
              permissions: {
                type: "string",
                required: false,
                defaultValue: "[]",
              },
            },
          },
        },
        organizationHooks: {
          beforeCreateInvitation: async ({ invitation, inviter }) => {
            const permissions = await validateInvitationPermissions(
              prisma,
              invitation.organizationId,
              inviter.id,
              JSON.parse(invitation.permissions ?? "[]"),
            );
            return { data: { permissions: JSON.stringify(permissions) } };
          },
          beforeAcceptInvitation: async ({ invitation }) => {
            await validateInvitationPermissions(
              prisma,
              invitation.organizationId,
              invitation.inviterId,
              JSON.parse(invitation.permissions),
            );
          },
          afterAcceptInvitation: async ({ invitation, member, user }) => {
            await applyInvitationPermissions(
              prisma,
              {
                id: invitation.id,
                organizationId: invitation.organizationId,
                permissions: JSON.parse(invitation.permissions),
              },
              member,
            );
            await createAuditWriter(prisma, invitation.organizationId, user.id)(
              "accept_invitation",
              "invitation",
              invitation.id,
              {
                role: member.role,
              },
            );
          },
        },
        sendInvitationEmail: async ({ email, invitation }) => {
          const url = new URL(
            `/auth/invitations/${encodeURIComponent(invitation.id)}`,
            config.betterAuthUrl,
          );
          await sendAuthEmail({
            type: "invitation",
            to: email,
            url: url.toString(),
          });
        },
      }),
    ],
    advanced: {
      database: {
        generateId: () => genId(),
      },
      useSecureCookies: config.betterAuthUrl.startsWith("https://"),
    },
    trustedOrigins: [config.betterAuthUrl],
  });
}

export type Auth = ReturnType<typeof createAuth>;

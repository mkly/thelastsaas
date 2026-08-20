import { mcp } from "@better-auth/mcp";
import type { PrismaClient } from "@prisma/client";
import { genId } from "@lastsaas/shared";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import {
  bearer,
  deviceAuthorization,
  jwt,
  magicLink,
  organization,
} from "better-auth/plugins";

import type { AppConfig } from "./config";
import { createAuditWriter } from "./db/audit";
import { syncMemberRole } from "./db/casbin";

export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 90;
const SESSION_UPDATE_AGE = 60 * 60 * 24;
export const MCP_TOOLS_SCOPE = "mcp:tools";
export const MCP_ORGANIZATION_CLAIM =
  "https://thelastsaas.com/claims/organization_id";

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
  console.info(`[auth:${type}] ${to}: ${url}`);
};

export function createAuth(
  prisma: PrismaClient,
  config: AppConfig,
  sendAuthEmail: AuthEmailSender = logAuthEmail,
) {
  const mcpResource = mcpResourceUrl(config);

  return betterAuth({
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthUrl,
    database: prismaAdapter(prisma, { provider: "sqlite" }),
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE,
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      sendResetPassword: async ({ user, url }) => {
        await sendAuthEmail({ type: "password-reset", to: user.email, url });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await sendAuthEmail({
          type: "email-verification",
          to: user.email,
          url,
        });
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
      bearer(),
      jwt(),
      mcp({
        resource: mcpResource,
        loginPage: "/auth/login",
        consentPage: "/auth/mcp/consent",
        scopes: ["openid", "profile", "offline_access", MCP_TOOLS_SCOPE],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        postLogin: {
          page: "/auth/mcp/select-organization",
          shouldRedirect: async ({ session, scopes }) => {
            if (!scopes.includes(MCP_TOOLS_SCOPE)) return false;
            const organizationId = session.activeOrganizationId;
            if (typeof organizationId !== "string") return true;
            const membership = await prisma.member.findUnique({
              where: {
                organizationId_userId: {
                  organizationId,
                  userId: session.userId,
                },
              },
              select: { id: true },
            });
            return !membership;
          },
          consentReferenceId: ({ session, scopes }) => {
            if (!scopes.includes(MCP_TOOLS_SCOPE)) return undefined;
            const organizationId = session?.activeOrganizationId;
            if (typeof organizationId !== "string") {
              throw new Error("Select an organization before granting access");
            }
            return organizationId;
          },
        },
        customAccessTokenClaims: ({ referenceId }) =>
          referenceId ? { [MCP_ORGANIZATION_CLAIM]: referenceId } : {},
      }),
      deviceAuthorization({
        verificationUri: "/auth/device",
        schema: {},
      }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await sendAuthEmail({ type: "magic-link", to: email, url });
        },
      }),
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: "admin",
        // Last SaaS generates opaque UUIDv7 invitation IDs. Better Auth cannot
        // infer that from a custom generator, so preserve the emailed-link flow.
        requireEmailVerificationOnInvitation: false,
        organizationHooks: {
          afterAcceptInvitation: async ({ invitation, member, user }) => {
            await syncMemberRole(
              prisma,
              invitation.organizationId,
              user.id,
              member.role,
              member.role,
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

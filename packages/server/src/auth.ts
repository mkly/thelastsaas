import type { PrismaClient } from "@prisma/client";
import { genId } from "@lastsaas/shared";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import {
  bearer,
  deviceAuthorization,
  magicLink,
  organization,
} from "better-auth/plugins";

import type { AppConfig } from "./config";
import { createAuditWriter } from "./db/audit";
import { syncMemberRole } from "./db/casbin";

export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 90;
const SESSION_UPDATE_AGE = 60 * 60 * 24;

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

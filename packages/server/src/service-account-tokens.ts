import { genId } from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

import type { AppConfig } from "./config";
import { removeMemberAccess } from "./db/casbin";
import {
  createServiceAccount,
  type CreateServiceAccountInput,
} from "./db/service-accounts";
import type { AppServices } from "./services";

export const SERVICE_ACCOUNT_CLAIM_TTL_MS = 10 * 60 * 1_000;
const CLAIM_IDENTIFIER_PREFIX = "service-account-token:";

type ClaimPayload = {
  apiKeyId: string;
  organizationId: string;
  serviceAccountId: string;
  token: string;
};

export class TokenClaimNotFoundError extends Error {}
export class TokenClaimExpiredError extends Error {}
export class TokenClaimForbiddenError extends Error {}

function claimIdentifier(code: string): string {
  return `${CLAIM_IDENTIFIER_PREFIX}${createHash("sha256").update(code).digest("hex")}`;
}

function parseClaimPayload(value: string): ClaimPayload | null {
  try {
    const payload = JSON.parse(value) as Partial<ClaimPayload>;
    return typeof payload.apiKeyId === "string" &&
      typeof payload.organizationId === "string" &&
      typeof payload.serviceAccountId === "string" &&
      typeof payload.token === "string"
      ? (payload as ClaimPayload)
      : null;
  } catch {
    return null;
  }
}

export async function issueServiceAccountTokenClaim(
  services: AppServices,
  config: AppConfig,
  organizationId: string,
  input: CreateServiceAccountInput,
  now = new Date(),
) {
  const account = await createServiceAccount(
    services.prisma,
    config.betterAuthUrl,
    organizationId,
    input,
  );

  try {
    const apiKey = await services.auth.api.createApiKey({
      body: {
        name: "service-account",
        userId: account.user.id,
        metadata: { organizationId },
      },
    });
    const code = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + SERVICE_ACCOUNT_CLAIM_TTL_MS);
    await services.prisma.verification.create({
      data: {
        id: genId(),
        identifier: claimIdentifier(code),
        value: JSON.stringify({
          apiKeyId: apiKey.id,
          organizationId,
          serviceAccountId: account.user.id,
          token: apiKey.key,
        } satisfies ClaimPayload),
        expiresAt,
      },
    });

    return {
      serviceAccount: account,
      apiKeyId: apiKey.id,
      claimUrl: new URL(
        `/tokens/claim/${encodeURIComponent(code)}`,
        config.betterAuthUrl,
      ).toString(),
      expiresAt,
    };
  } catch (error) {
    await removeMemberAccess(
      services.prisma,
      organizationId,
      account.user.id,
    ).catch(() => undefined);
    await services.prisma.user
      .delete({ where: { id: account.user.id } })
      .catch(() => undefined);
    throw error;
  }
}

export async function claimServiceAccountToken(
  prisma: PrismaClient,
  code: string,
  claimantUserId: string,
  now = new Date(),
): Promise<ClaimPayload> {
  const claim = await prisma.verification.findFirst({
    where: { identifier: claimIdentifier(code) },
  });
  if (!claim) throw new TokenClaimNotFoundError("Claim not found");

  const payload = parseClaimPayload(claim.value);
  if (!payload) {
    await prisma.verification.deleteMany({ where: { id: claim.id } });
    throw new TokenClaimNotFoundError("Claim not found");
  }

  const membership = await prisma.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: payload.organizationId,
        userId: claimantUserId,
      },
    },
    select: { role: true },
  });
  if (membership?.role !== "admin") {
    throw new TokenClaimForbiddenError(
      "Only an administrator of the owning organization can claim this token",
    );
  }

  if (claim.expiresAt <= now) {
    await prisma.$transaction([
      prisma.verification.deleteMany({ where: { id: claim.id } }),
      prisma.apikey.updateMany({
        where: { id: payload.apiKeyId },
        data: { enabled: false },
      }),
    ]);
    throw new TokenClaimExpiredError("Claim expired");
  }

  const consumed = await prisma.verification.deleteMany({
    where: { id: claim.id, expiresAt: { gt: now } },
  });
  if (consumed.count !== 1) {
    throw new TokenClaimNotFoundError("Claim not found");
  }
  return payload;
}

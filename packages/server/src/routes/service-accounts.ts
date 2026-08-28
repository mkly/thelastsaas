import { errorResponse } from "@lastsaas/shared";
import { Hono } from "hono";

import { createServiceAccountSchema } from "../db/service-accounts";
import type { AppEnvironment } from "../env";
import { requirePermission } from "../middleware/permission";
import {
  issueExistingServiceAccountTokenClaim,
  issueServiceAccountTokenClaim,
} from "../service-account-tokens";

const manageMembers = requirePermission("manage", () => "/members");

function validationMessage(error: { issues: Array<{ message: string }> }) {
  return error.issues.map((issue) => issue.message).join("; ");
}

async function findServiceAccount(
  context: Parameters<typeof manageMembers>[0],
  serviceAccountId: string,
) {
  return context.get("services").prisma.user.findFirst({
    where: {
      id: serviceAccountId,
      kind: "service",
      members: { some: { organizationId: context.get("orgId") } },
    },
    select: { id: true, name: true },
  });
}

function notFound(context: Parameters<typeof manageMembers>[0]) {
  return context.json(
    errorResponse("NotFound", "Service account or API key not found"),
    404,
  );
}

function belongsToOrganization(
  metadata: string | null,
  organizationId: string,
) {
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return parsed.organizationId === organizationId;
  } catch {
    return false;
  }
}

export const serviceAccountRouter = new Hono<AppEnvironment>()
  .post("/", manageMembers, async (context) => {
    const parsed = createServiceAccountSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        errorResponse("InvalidRequest", validationMessage(parsed.error)),
        400,
      );
    }

    try {
      const issued = await issueServiceAccountTokenClaim(
        context.get("services"),
        context.get("config"),
        context.get("orgId"),
        parsed.data,
      );
      await context.get("audit")(
        "create_service_account",
        "service_account",
        issued.serviceAccount.user.id,
        {
          role: issued.serviceAccount.member.role,
          api_key_id: issued.apiKeyId,
        },
      );
      return context.json(
        {
          status: "ok" as const,
          service_account_id: issued.serviceAccount.user.id,
          member_id: issued.serviceAccount.member.id,
          role: issued.serviceAccount.member.role,
          claim_url: issued.claimUrl,
          claim_expires_at: issued.expiresAt.toISOString(),
        },
        201,
      );
    } catch (error) {
      return context.json(
        errorResponse(
          "InvalidRequest",
          error instanceof Error
            ? error.message
            : "Failed to create service account",
        ),
        400,
      );
    }
  })
  .get("/:serviceAccountId/api-keys", manageMembers, async (context) => {
    const serviceAccount = await findServiceAccount(
      context,
      context.req.param("serviceAccountId"),
    );
    if (!serviceAccount) return notFound(context);

    const apiKeys = (
      await context.get("services").prisma.apikey.findMany({
        where: { referenceId: serviceAccount.id },
        select: {
          id: true,
          name: true,
          start: true,
          prefix: true,
          enabled: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
          lastRequest: true,
          metadata: true,
        },
        orderBy: { createdAt: "desc" },
      })
    ).filter((key) =>
      belongsToOrganization(key.metadata, context.get("orgId")),
    );
    return context.json({
      status: "ok" as const,
      service_account_id: serviceAccount.id,
      api_keys: apiKeys.map((key) => ({
        id: key.id,
        name: key.name,
        start: key.start,
        prefix: key.prefix,
        enabled: key.enabled !== false,
        expires_at: key.expiresAt,
        created_at: key.createdAt,
        updated_at: key.updatedAt,
        last_request_at: key.lastRequest,
      })),
    });
  })
  .delete(
    "/:serviceAccountId/api-keys/:apiKeyId",
    manageMembers,
    async (context) => {
      const serviceAccount = await findServiceAccount(
        context,
        context.req.param("serviceAccountId"),
      );
      if (!serviceAccount) return notFound(context);

      const key = await context.get("services").prisma.apikey.findFirst({
        where: {
          id: context.req.param("apiKeyId"),
          referenceId: serviceAccount.id,
        },
        select: { id: true, metadata: true },
      });
      if (!key || !belongsToOrganization(key.metadata, context.get("orgId"))) {
        return notFound(context);
      }

      await context.get("services").prisma.apikey.update({
        where: { id: key.id },
        data: { enabled: false },
      });

      await context.get("audit")(
        "revoke_service_account_api_key",
        "api_key",
        key.id,
        { service_account_id: serviceAccount.id },
      );
      return context.json({ status: "ok" as const });
    },
  )
  .post(
    "/:serviceAccountId/api-keys/:apiKeyId/rotate",
    manageMembers,
    async (context) => {
      const serviceAccount = await findServiceAccount(
        context,
        context.req.param("serviceAccountId"),
      );
      if (!serviceAccount) return notFound(context);

      const currentKey = await context.get("services").prisma.apikey.findFirst({
        where: {
          id: context.req.param("apiKeyId"),
          referenceId: serviceAccount.id,
        },
        select: { id: true, name: true, metadata: true },
      });
      if (
        !currentKey ||
        !belongsToOrganization(currentKey.metadata, context.get("orgId"))
      ) {
        return notFound(context);
      }

      let replacementApiKeyId: string | undefined;
      try {
        const issued = await issueExistingServiceAccountTokenClaim(
          context.get("services"),
          context.get("config"),
          context.get("orgId"),
          serviceAccount,
          currentKey.name ?? "service-account",
        );
        replacementApiKeyId = issued.apiKeyId;
        await context.get("services").prisma.apikey.update({
          where: { id: currentKey.id },
          data: { enabled: false },
        });
        await context.get("audit")(
          "rotate_service_account_api_key",
          "api_key",
          currentKey.id,
          {
            service_account_id: serviceAccount.id,
            replacement_api_key_id: issued.apiKeyId,
          },
        );
        return context.json({
          status: "ok" as const,
          service_account_id: serviceAccount.id,
          api_key_id: issued.apiKeyId,
          claim_url: issued.claimUrl,
          claim_expires_at: issued.expiresAt.toISOString(),
        });
      } catch (error) {
        if (replacementApiKeyId) {
          await context
            .get("services")
            .prisma.apikey.updateMany({
              where: { id: replacementApiKeyId },
              data: { enabled: false },
            })
            .catch(() => undefined);
        }
        return context.json(
          errorResponse(
            "InvalidRequest",
            error instanceof Error ? error.message : "Failed to rotate API key",
          ),
          400,
        );
      }
    },
  );

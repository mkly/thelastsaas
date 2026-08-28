import { errorResponse } from "@lastsaas/shared";
import { Hono } from "hono";

import { createServiceAccountSchema } from "../db/service-accounts";
import type { AppEnvironment } from "../env";
import { requirePermission } from "../middleware/permission";
import { issueServiceAccountTokenClaim } from "../service-account-tokens";

const manageMembers = requirePermission("manage", () => "/members");

function validationMessage(error: { issues: Array<{ message: string }> }) {
  return error.issues.map((issue) => issue.message).join("; ");
}

export const serviceAccountRouter = new Hono<AppEnvironment>().post(
  "/",
  manageMembers,
  async (context) => {
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
  },
);

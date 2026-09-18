import { LastSaasError, ErrorCode } from "@lastsaas/shared";
import type { AppConfig as Config } from "../config";
import type { AppServices as Services } from "../services";

export const API_KEY_ORGANIZATION_METADATA_FIELD = "organizationId";

export type McpApiKeyPrincipal = {
  orgId: string;
  userId: string;
};

export async function resolveMcpApiKeyPrincipal(
  services: Services,
  request: Request,
): Promise<McpApiKeyPrincipal | null> {
  const authorization = request.headers.get("authorization");
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
  if (!match) return null;

  const result = await services.auth.api
    .verifyApiKey({ body: { key: match[1]! } })
    .catch(() => null);
  if (!result?.valid || !result.key) return null;

  const organizationId =
    result.key.metadata?.[API_KEY_ORGANIZATION_METADATA_FIELD];
  return typeof organizationId === "string" && organizationId
    ? { orgId: organizationId, userId: result.key.referenceId }
    : null;
}

export type McpToolContext = {
  services: Services;
  config: Config;
  orgId: string | null;
  userId: string;
  clientId?: string;
};

export function requireOrganization(context: McpToolContext): string {
  if (!context.orgId) {
    throw new LastSaasError(
      ErrorCode.Unauthorized,
      "No active organization. Use organizations_list, then organizations_select or organizations_create.",
    );
  }
  return context.orgId;
}

export async function resolveActiveOrganization(
  services: Services,
  userId: string,
  clientId: string,
): Promise<string | null> {
  const preference = await services.prisma.mcpOrganization.findUnique({
    where: { userId_clientId: { userId, clientId } },
  });
  if (preference?.orgId) {
    const member = await services.prisma.member.findUnique({
      where: {
        organizationId_userId: { organizationId: preference.orgId, userId },
      },
    });
    if (member) return preference.orgId;
    // A revoked selection must not silently redirect data operations to another organization.
    return null;
  }
  const memberships = await services.prisma.member.findMany({
    where: { userId },
    take: 2,
    select: { organizationId: true },
  });
  if (memberships.length !== 1) return null;
  const orgId = memberships[0]!.organizationId;
  const selected = await services.prisma.mcpOrganization.upsert({
    where: { userId_clientId: { userId, clientId } },
    create: { userId, clientId, orgId },
    update: {},
  });
  return selected.orgId;
}

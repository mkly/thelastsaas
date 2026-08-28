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
  orgId: string;
  userId: string;
};

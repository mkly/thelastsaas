import { createHmac, timingSafeEqual } from "node:crypto";
import { FileMissingError } from "@lastsaas/shared";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppConfig } from "./config";
import type { AppServices } from "./services";
import { checkPermission } from "./db/casbin";
import { getFile } from "./db/files";

export const DOWNLOAD_TTL_SECONDS = 300;
const claimsSchema = z
  .object({
    orgId: z.string(),
    userId: z.string(),
    fileId: z.string(),
    expires: z.number().int(),
  })
  .strict();

export function downloadDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function authorizedFile(
  services: AppServices,
  orgId: string,
  userId: string,
  fileId: string,
) {
  const member = await services.prisma.member.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
  });
  if (
    !member ||
    !(await checkPermission(services.prisma, orgId, userId, "/files", "read"))
      .allowed
  )
    throw new HTTPException(403, {
      message:
        "You do not have permission to download files from this organization",
    });
  try {
    return await getFile(services.prisma, orgId, fileId);
  } catch (error) {
    if (error instanceof FileMissingError)
      throw new HTTPException(404, { message: "File not found" });
    throw error;
  }
}

function signature(payload: string, config: AppConfig) {
  return createHmac("sha256", config.betterAuthSecret)
    .update(`file-download:${payload}`)
    .digest();
}

export async function createDownloadLink(
  services: AppServices,
  config: AppConfig,
  orgId: string,
  userId: string,
  fileId: string,
) {
  const file = await authorizedFile(services, orgId, userId, fileId);
  const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
  const key = `${orgId}/${file.id}`;
  let downloadUrl: string;
  if (services.storage.presignDownload) {
    downloadUrl = await services.storage.presignDownload(
      key,
      downloadDisposition(file.filename),
      DOWNLOAD_TTL_SECONDS,
    );
  } else {
    const payload = Buffer.from(
      JSON.stringify({ orgId, userId, fileId, expires }),
    ).toString("base64url");
    const url = new URL(`/file-downloads/${file.id}`, config.betterAuthUrl);
    url.searchParams.set(
      "token",
      `${payload}.${signature(payload, config).toString("base64url")}`,
    );
    downloadUrl = url.toString();
  }
  return {
    file,
    download_url: downloadUrl,
    expires_at: new Date(expires * 1000).toISOString(),
  };
}

export async function downloadLocalFile(
  services: AppServices,
  config: AppConfig,
  fileId: string,
  token: string,
) {
  if (token.length > 4096)
    throw new HTTPException(404, { message: "Invalid download link" });
  const parts = token.split(".");
  const payload = parts[0] ?? "";
  const supplied = Buffer.from(parts[1] ?? "", "base64url");
  const expected = signature(payload, config);
  if (
    parts.length !== 2 ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new HTTPException(404, { message: "Invalid download link" });
  let claims;
  try {
    claims = claimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
  } catch {
    throw new HTTPException(404, { message: "Invalid download link" });
  }
  if (claims.fileId !== fileId)
    throw new HTTPException(404, { message: "Invalid download link" });
  if (claims.expires <= Math.floor(Date.now() / 1000))
    throw new HTTPException(410, {
      message: "This download link has expired. Request a new link.",
    });
  const file = await authorizedFile(
    services,
    claims.orgId,
    claims.userId,
    claims.fileId,
  );
  const content = await services.storage.read(`${claims.orgId}/${file.id}`);
  if (!content)
    throw new HTTPException(404, { message: "File content not found" });
  return new Response(content, {
    headers: {
      "Content-Disposition": downloadDisposition(file.filename),
      "Content-Type": "application/octet-stream",
      ...(file.size_bytes === null
        ? {}
        : { "Content-Length": String(file.size_bytes) }),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}

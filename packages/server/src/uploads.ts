import { createHash, randomBytes } from "node:crypto";
import { genId, sanitizePathComponent } from "@lastsaas/shared";
import type { FileUpload } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppConfig } from "./config";
import type { AppServices } from "./services";
import { checkPermission } from "./db/casbin";
import { getFile } from "./db/files";

export const UPLOAD_TTL_SECONDS = 5 * 60;
export const uploadMetadataSchema = z
  .object({
    filename: z.string().min(1).max(255),
    size_bytes: z.number().int().nonnegative(),
    mime_type: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\r\n]+$/)
      .default("application/octet-stream"),
    path: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type UploadMetadata = z.input<typeof uploadMetadataSchema>;
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const stagingKey = (id: string) => `uploads/${id}`;
const fail = (
  status: 400 | 403 | 404 | 409 | 410 | 413,
  message: string,
): never => {
  throw new HTTPException(status, { message });
};

export async function authorizeUpload(
  services: AppServices,
  orgId: string,
  userId: string,
) {
  const member = await services.prisma.member.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
  });
  if (
    !member ||
    !(await checkPermission(services.prisma, orgId, userId, "/files", "write"))
      .allowed
  )
    fail(
      403,
      "You no longer have permission to upload files to this organization",
    );
}

export async function createUpload(
  services: AppServices,
  config: AppConfig,
  orgId: string,
  userId: string,
) {
  await authorizeUpload(services, orgId, userId);
  // Bound abandoned sessions and clean temporary objects opportunistically.
  const expired = await services.prisma.fileUpload.findMany({
    where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } },
    take: 50,
  });
  for (const old of expired) {
    await services.storage.delete(stagingKey(old.id));
    if (old.status !== "complete")
      await services.storage.delete(`${old.orgId}/${old.id}`);
    await services.prisma.fileUpload.deleteMany({ where: { id: old.id } });
  }
  if (
    (await services.prisma.fileUpload.count({
      where: {
        orgId,
        userId,
        status: { not: "complete" },
        expiresAt: { gt: new Date() },
      },
    })) >= 20
  )
    fail(
      409,
      "Too many pending uploads. Finish an upload or wait for its link to expire.",
    );
  const token = randomBytes(32).toString("base64url");
  const upload = await services.prisma.fileUpload.create({
    data: {
      id: genId(),
      orgId,
      userId,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
    },
  });
  return {
    upload,
    token,
    upload_id: upload.id,
    expires_at: upload.expiresAt.toISOString(),
    browser_url: new URL(
      `/uploads/${upload.id}#${token}`,
      config.betterAuthUrl,
    ).toString(),
  };
}

export async function getUpload(
  services: AppServices,
  id: string,
  identity: { token: string } | { orgId: string; userId: string },
  statusOnly = false,
) {
  const upload = await services.prisma.fileUpload.findFirst({
    where: {
      id,
      ...("token" in identity ? { tokenHash: hash(identity.token) } : identity),
    },
  });
  if (!upload) return fail(404, "Upload not found");
  if (
    (!statusOnly || "token" in identity) &&
    upload.expiresAt.getTime() <= Date.now()
  )
    fail(410, "This upload link has expired. Ask for a new link.");
  await authorizeUpload(services, upload.orgId, upload.userId);
  return upload;
}

export async function prepareUpload(
  services: AppServices,
  config: AppConfig,
  upload: FileUpload,
  token: string,
  input: UploadMetadata,
) {
  const parsed = uploadMetadataSchema.safeParse(input);
  if (!parsed.success)
    return fail(400, "Invalid filename, size, content type, or path");
  const metadata = parsed.data;
  if (
    metadata.size_bytes > config.maxUploadSize ||
    metadata.size_bytes > 5 * 1024 ** 3
  )
    fail(
      413,
      `File exceeds the ${Math.min(config.maxUploadSize, 5 * 1024 ** 3)}-byte upload limit`,
    );
  const filename = sanitizePathComponent(metadata.filename);
  const path = metadata.path ?? filename;
  if (
    Buffer.byteLength(path) > 1024 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail(400, "Use a relative file path without empty, '.' or '..' segments");
  if (
    await services.prisma.file.findFirst({
      where: { orgId: upload.orgId, path },
    })
  )
    fail(409, "A file with that path already exists");
  const changed = await services.prisma.fileUpload.updateMany({
    where: { id: upload.id, status: "pending" },
    data: {
      filename,
      path,
      mimeType: metadata.mime_type,
      sizeBytes: metadata.size_bytes,
      status: "prepared",
    },
  });
  if (!changed.count)
    fail(
      409,
      "This upload has already been prepared. Use its existing upload URL or request a new link.",
    );
  const target = services.storage.presignUpload
    ? await services.storage.presignUpload(
        stagingKey(upload.id),
        metadata.size_bytes,
        metadata.mime_type,
        Math.max(
          1,
          Math.floor((upload.expiresAt.getTime() - Date.now()) / 1000),
        ),
      )
    : {
        url: new URL(
          `/uploads/${upload.id}/content`,
          config.betterAuthUrl,
        ).toString(),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": metadata.mime_type,
        },
      };
  return {
    upload_id: upload.id,
    upload_url: target.url,
    method: "PUT" as const,
    headers: target.headers,
    expires_at: upload.expiresAt.toISOString(),
    complete_url: new URL(
      `/uploads/${upload.id}/complete`,
      config.betterAuthUrl,
    ).toString(),
    complete_headers: { Authorization: `Bearer ${token}` },
  };
}

export async function writeUpload(
  services: AppServices,
  upload: FileUpload,
  body: ReadableStream<Uint8Array> | null,
) {
  if (services.storage.presignUpload)
    fail(400, "Use the provided storage upload URL");
  if (!body) fail(400, "File content is required");
  const claimed = await services.prisma.fileUpload.updateMany({
    where: { id: upload.id, status: "prepared" },
    data: { status: "receiving" },
  });
  if (!claimed.count) fail(409, "Upload is already in progress or complete");
  try {
    let size = 0;
    const counted = (async function* () {
      for await (const chunk of body! as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > upload.sizeBytes!)
          fail(413, "File is larger than the declared size");
        yield chunk;
      }
      if (size !== upload.sizeBytes)
        fail(400, "File size does not match the declared size");
    })();
    await services.storage.write(stagingKey(upload.id), counted);
  } finally {
    await services.prisma.fileUpload.updateMany({
      where: { id: upload.id, status: "receiving" },
      data: { status: "prepared" },
    });
  }
}

export async function completeUpload(
  services: AppServices,
  upload: FileUpload,
) {
  if (upload.status === "complete")
    return getFile(services.prisma, upload.orgId, upload.id);
  const claimed = await services.prisma.fileUpload.updateMany({
    where: { id: upload.id, status: "prepared" },
    data: { status: "completing" },
  });
  if (!claimed.count) return fail(409, "Upload is not ready to complete");
  const finalKey = `${upload.orgId}/${upload.id}`;
  let promoted = false;
  try {
    const info = await services.storage.stat(stagingKey(upload.id));
    if (!info) fail(409, "Upload the file content before completing");
    if (info!.size !== upload.sizeBytes)
      fail(400, "Uploaded file size does not match");
    await services.storage.promote(stagingKey(upload.id), finalKey, info!.etag);
    promoted = true;
    await authorizeUpload(services, upload.orgId, upload.userId);
    await services.prisma.$transaction(async (tx) => {
      await tx.file.create({
        data: {
          id: upload.id,
          orgId: upload.orgId,
          filename: upload.filename!,
          path: upload.path!,
          mimeType: upload.mimeType,
          sizeBytes: upload.sizeBytes,
          uploadedBy: upload.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          id: genId(),
          orgId: upload.orgId,
          userId: upload.userId,
          action: "upload_file",
          resourceType: "file",
          resourceId: upload.id,
          details: { path: upload.path! },
        },
      });
      await tx.fileUpload.update({
        where: { id: upload.id },
        data: { status: "complete" },
      });
    });
  } catch (error) {
    if (promoted) await services.storage.delete(finalKey);
    await services.prisma.fileUpload.updateMany({
      where: { id: upload.id, status: "completing" },
      data: { status: "prepared" },
    });
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    )
      fail(409, "A file with that path already exists");
    throw error;
  }
  await services.storage.delete(stagingKey(upload.id)).catch(() => undefined);
  return getFile(services.prisma, upload.orgId, upload.id);
}

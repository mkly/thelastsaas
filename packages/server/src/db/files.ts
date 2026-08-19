import { FileMissingError, type File as ApiFile } from "@lastsaas/shared";
import type { File, PrismaClient } from "@prisma/client";

function formatFile(file: File): ApiFile {
  return {
    id: file.id,
    path: file.path,
    filename: file.filename,
    mime_type: file.mimeType,
    size_bytes: file.sizeBytes,
    collection_id: file.collectionId,
    record_id: file.recordId,
    uploaded_by: file.uploadedBy,
    created_at: file.createdAt.toISOString(),
  };
}

export interface CreateFileInput {
  id: string;
  orgId: string;
  path: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  uploadedBy: string;
}

export async function createFile(
  prisma: PrismaClient,
  input: CreateFileInput,
): Promise<ApiFile> {
  const file = await prisma.file.create({ data: input });
  return formatFile(file);
}

export async function getFile(
  prisma: PrismaClient,
  orgId: string,
  fileId: string,
): Promise<ApiFile> {
  const file = await prisma.file.findFirst({
    where: { id: fileId, orgId },
  });
  if (!file) throw new FileMissingError(fileId);
  return formatFile(file);
}

export async function listFiles(
  prisma: PrismaClient,
  orgId: string,
  prefix = "",
): Promise<ApiFile[]> {
  const files = await prisma.file.findMany({
    where: {
      orgId,
      ...(prefix ? { path: { startsWith: prefix } } : {}),
    },
    orderBy: { path: "asc" },
  });
  return files.map(formatFile);
}

export async function deleteFile(
  prisma: PrismaClient,
  orgId: string,
  fileId: string,
): Promise<void> {
  const result = await prisma.file.deleteMany({
    where: { id: fileId, orgId },
  });
  if (result.count !== 1) throw new FileMissingError(fileId);
}

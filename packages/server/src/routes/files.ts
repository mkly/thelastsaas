import {
  FileMissingError,
  errorResponse,
  genId,
  sanitizePathComponent,
} from "@lastsaas/shared";
import createBusboy, { type FileInfo } from "busboy";
import { Hono } from "hono";
import type { Readable } from "node:stream";

import { createFile, deleteFile, getFile, listFiles } from "../db/files";
import type { AppEnvironment } from "../env";
import type { Storage, StorageInput } from "../storage/interface";

const MAX_PATH_BYTES = 1024;

class UploadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

interface ParsedUpload {
  filename: string;
  mimeType: string | null;
  path: string;
  sizeBytes: number;
}

function storageKey(orgId: string, fileId: string): string {
  return `${orgId}/${fileId}`;
}

function validatePath(path: string): string {
  if (!path || new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) {
    throw new UploadError(
      "ValidationError",
      `path must be between 1 and ${MAX_PATH_BYTES} bytes`,
    );
  }
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new UploadError(
      "ValidationError",
      "path must be a relative slash-separated file path without empty, '.' or '..' segments",
    );
  }
  return path;
}

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries());
}

async function parseUpload(
  request: Request,
  storage: Storage,
  key: string,
  maxFileSize: number,
): Promise<ParsedUpload> {
  if (!request.body) {
    throw new UploadError(
      "ValidationError",
      "A multipart request body is required",
    );
  }
  if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
    throw new UploadError(
      "ValidationError",
      "Content-Type must be multipart/form-data",
    );
  }

  let parser;
  try {
    parser = createBusboy({
      headers: requestHeaders(request),
      limits: {
        fieldNameSize: 100,
        fieldSize: MAX_PATH_BYTES,
        fields: 2,
        fileSize: maxFileSize + 1,
        files: 2,
        parts: 3,
      },
    });
  } catch (error) {
    throw new UploadError(
      "ValidationError",
      error instanceof Error ? error.message : "Invalid multipart request",
    );
  }

  let explicitPath: string | undefined;
  let filename: string | undefined;
  let mimeType: string | null = null;
  let sizeBytes = 0;
  let fieldSeen = false;
  let fileSeen = false;
  let uploadError: UploadError | undefined;
  let writePromise: Promise<void> | undefined;

  const parsed = new Promise<ParsedUpload>((resolve, reject) => {
    parser.on("field", (name, value, info) => {
      if (fieldSeen) {
        uploadError ??= new UploadError(
          "ValidationError",
          "Only one 'path' field may be supplied",
        );
      } else if (name !== "path") {
        uploadError ??= new UploadError(
          "ValidationError",
          `Unexpected multipart field '${name}'`,
        );
      } else if (info.valueTruncated) {
        uploadError ??= new UploadError(
          "ValidationError",
          `path must not exceed ${MAX_PATH_BYTES} bytes`,
        );
      } else {
        explicitPath = value;
      }
      fieldSeen = true;
    });

    parser.on("file", (field, file: Readable, info: FileInfo) => {
      if (fileSeen) {
        uploadError ??= new UploadError(
          "ValidationError",
          "Exactly one file may be uploaded",
        );
        file.resume();
        return;
      }
      fileSeen = true;
      if (field !== "file") {
        uploadError ??= new UploadError(
          "ValidationError",
          `Unexpected file field '${field}'; expected 'file'`,
        );
        file.resume();
        return;
      }

      filename = sanitizePathComponent(info.filename);
      mimeType = info.mimeType || null;
      file.on("limit", () => {
        uploadError ??= new UploadError(
          "PayloadTooLarge",
          `File exceeds the configured ${maxFileSize}-byte upload limit`,
          413,
        );
      });

      const countedContent = (async function* (): StorageInput {
        for await (const chunk of file) {
          const bytes =
            chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          sizeBytes += bytes.byteLength;
          yield bytes;
        }
      })();
      writePromise = storage.write(key, countedContent).catch((error) => {
        file.resume();
        throw error;
      });
    });

    parser.on("filesLimit", () => {
      uploadError ??= new UploadError(
        "ValidationError",
        "Exactly one file may be uploaded",
      );
    });
    parser.on("fieldsLimit", () => {
      uploadError ??= new UploadError(
        "ValidationError",
        "Only the optional 'path' field is accepted",
      );
    });
    parser.on("partsLimit", () => {
      uploadError ??= new UploadError(
        "ValidationError",
        "Multipart request contains too many parts",
      );
    });
    parser.on("error", reject);
    parser.on("close", () => {
      void (async () => {
        try {
          await writePromise;
          if (uploadError) throw uploadError;
          if (!filename || !writePromise) {
            throw new UploadError(
              "ValidationError",
              "Multipart request must contain one 'file' part",
            );
          }
          resolve({
            filename,
            mimeType,
            path: validatePath(explicitPath ?? filename),
            sizeBytes,
          });
        } catch (error) {
          reject(error);
        }
      })();
    });
  });

  const input = request.body.pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        if (parser.write(chunk)) return undefined;
        return new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            parser.off("error", onError);
            resolve();
          };
          const onError = (error: Error) => {
            parser.off("drain", onDrain);
            reject(error);
          };
          parser.once("drain", onDrain);
          parser.once("error", onError);
        });
      },
      close() {
        parser.end();
      },
      abort(reason) {
        parser.destroy(
          reason instanceof Error ? reason : new Error(String(reason)),
        );
      },
    }),
  );

  const [result] = await Promise.all([parsed, input]);
  return result;
}

function isUniquePathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "P2002"
  );
}

function missingFileResponse(error: FileMissingError) {
  return errorResponse(error.code, error.message);
}

export const fileRouter = new Hono<AppEnvironment>()
  .post("/", async (context) => {
    const { prisma, storage } = context.get("services");
    const orgId = context.get("orgId");
    const fileId = genId();
    const key = storageKey(orgId, fileId);

    try {
      const upload = await parseUpload(
        context.req.raw,
        storage,
        key,
        context.get("config").maxUploadSize,
      );
      const file = await createFile(prisma, {
        id: fileId,
        orgId,
        path: upload.path,
        filename: upload.filename,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        uploadedBy: context.get("userId"),
      });
      await context.get("audit")("upload_file", "file", fileId, {
        path: upload.path,
      });
      return context.json({ status: "ok" as const, ...file }, 201);
    } catch (error) {
      await storage.delete(key).catch(() => undefined);
      if (error instanceof UploadError) {
        return context.json(
          errorResponse(error.code, error.message),
          error.status,
        );
      }
      if (isUniquePathError(error)) {
        return context.json(
          errorResponse(
            "FileExistsError",
            "A file with that path already exists in this organization",
          ),
          409,
        );
      }
      throw error;
    }
  })
  .get("/", async (context) => {
    const prefix = context.req.query("prefix") ?? "";
    if (new TextEncoder().encode(prefix).byteLength > MAX_PATH_BYTES) {
      return context.json(
        errorResponse(
          "ValidationError",
          `prefix must not exceed ${MAX_PATH_BYTES} bytes`,
        ),
        400,
      );
    }
    const files = await listFiles(
      context.get("services").prisma,
      context.get("orgId"),
      prefix,
    );
    return context.json({ status: "ok" as const, files });
  })
  .get("/:id/content", async (context) => {
    const { prisma, storage } = context.get("services");
    try {
      const file = await getFile(
        prisma,
        context.get("orgId"),
        context.req.param("id"),
      );
      const content = await storage.read(
        storageKey(context.get("orgId"), file.id),
      );
      if (!content) throw new FileMissingError(file.id);
      const safeFilename = file.filename.replace(/["\\\r\n]/g, "_");
      return new Response(content, {
        headers: {
          "Content-Disposition": `attachment; filename="${safeFilename}"`,
          "Content-Length": String(file.size_bytes ?? 0),
          "Content-Type": file.mime_type ?? "application/octet-stream",
        },
      });
    } catch (error) {
      if (error instanceof FileMissingError) {
        return context.json(missingFileResponse(error), 404);
      }
      throw error;
    }
  })
  .get("/:id", async (context) => {
    try {
      const file = await getFile(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("id"),
      );
      return context.json({ status: "ok" as const, ...file });
    } catch (error) {
      if (error instanceof FileMissingError) {
        return context.json(missingFileResponse(error), 404);
      }
      throw error;
    }
  })
  .delete("/:id", async (context) => {
    const { prisma, storage } = context.get("services");
    const orgId = context.get("orgId");
    const fileId = context.req.param("id");
    try {
      const file = await getFile(prisma, orgId, fileId);
      await storage.delete(storageKey(orgId, file.id));
      await deleteFile(prisma, orgId, file.id);
      await context.get("audit")("delete_file", "file", file.id, {
        path: file.path,
      });
      return context.json({ status: "ok" as const, message: "File deleted" });
    } catch (error) {
      if (error instanceof FileMissingError) {
        return context.json(missingFileResponse(error), 404);
      }
      throw error;
    }
  });

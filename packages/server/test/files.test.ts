import { describe, expect, mock, test } from "bun:test";
import type { File as PrismaFile } from "@prisma/client";
import { Hono } from "hono";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { AppEnvironment } from "../src/env";
import { fileRouter } from "../src/routes/files";
import type { Storage, StorageInput } from "../src/storage/interface";

async function* chunks(content: StorageInput): AsyncIterable<Uint8Array> {
  for await (const chunk of content as AsyncIterable<Uint8Array>) yield chunk;
}

class MemoryStorage implements Storage {
  readonly content = new Map<string, Uint8Array>();

  async write(key: string, content: StorageInput): Promise<void> {
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of chunks(content)) {
      parts.push(chunk.slice());
      size += chunk.byteLength;
    }
    const value = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      value.set(part, offset);
      offset += part.byteLength;
    }
    this.content.set(key, value);
  }

  async read(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const value = this.content.get(key);
    if (!value) return null;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(value);
        controller.close();
      },
    });
  }

  async delete(key: string): Promise<void> {
    this.content.delete(key);
  }
}

class FakeFiles {
  readonly rows = new Map<string, PrismaFile>();

  readonly model = {
    create: mock(
      async ({
        data,
      }: {
        data: Record<string, unknown>;
      }): Promise<PrismaFile> => {
        const duplicate = [...this.rows.values()].find(
          (file) => file.orgId === data.orgId && file.path === data.path,
        );
        if (duplicate) {
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          });
        }
        const now = new Date();
        const file: PrismaFile = {
          id: String(data.id),
          orgId: String(data.orgId),
          path: String(data.path),
          filename: String(data.filename),
          mimeType: data.mimeType ? String(data.mimeType) : null,
          sizeBytes: Number(data.sizeBytes),
          collectionId: null,
          recordId: null,
          uploadedBy: String(data.uploadedBy),
          createdAt: now,
          updatedAt: now,
        };
        this.rows.set(file.id, file);
        return file;
      },
    ),
    findFirst: mock(
      async ({ where }: { where: { id: string; orgId: string } }) =>
        [...this.rows.values()].find(
          (file) => file.id === where.id && file.orgId === where.orgId,
        ) ?? null,
    ),
    findMany: mock(
      async ({
        where,
      }: {
        where: { orgId: string; path?: { startsWith: string } };
      }) =>
        [...this.rows.values()]
          .filter(
            (file) =>
              file.orgId === where.orgId &&
              (!where.path || file.path.startsWith(where.path.startsWith)),
          )
          .sort((left, right) => left.path.localeCompare(right.path)),
    ),
    deleteMany: mock(
      async ({ where }: { where: { id: string; orgId: string } }) => {
        const file = [...this.rows.values()].find(
          (candidate) =>
            candidate.id === where.id && candidate.orgId === where.orgId,
        );
        if (file) this.rows.delete(file.id);
        return { count: file ? 1 : 0 };
      },
    ),
  };
}

function createFilesApp(storage: Storage, maxUploadSize = 50 * 1024 * 1024) {
  const files = new FakeFiles();
  const config = loadConfig({ MAX_UPLOAD_SIZE: String(maxUploadSize) });
  const app = new Hono<AppEnvironment>();
  app.use("*", async (context, next) => {
    context.set("config", config);
    context.set("services", {
      prisma: { file: files.model },
      storage,
    } as never);
    context.set("orgId", "org_1");
    context.set("userId", "user_1");
    context.set("audit", async () => undefined);
    await next();
  });
  app.route("/v1/orgs/:orgId/files", fileRouter);
  return { app, files };
}

function uploadRequest(path: string, content: string): Request {
  const form = new FormData();
  form.set("path", path);
  form.set("file", new File([content], "upload.txt", { type: "text/plain" }));
  return new Request("http://localhost/v1/orgs/org_1/files", {
    method: "POST",
    body: form,
  });
}

describe("files API", () => {
  test("uploads, prefix-lists, inspects, downloads, and deletes files", async () => {
    const storage = new MemoryStorage();
    const { app } = createFilesApp(storage);

    const firstResponse = await app.fetch(
      uploadRequest("docs/readme.txt", "streamed content"),
    );
    expect(firstResponse.status).toBe(201);
    const first = (await firstResponse.json()) as {
      id: string;
      path: string;
      size_bytes: number;
    };
    expect(first.path).toBe("docs/readme.txt");
    expect(first.size_bytes).toBe(16);

    expect(
      (await app.fetch(uploadRequest("images/logo.txt", "not-an-image")))
        .status,
    ).toBe(201);

    const listResponse = await app.request("/v1/orgs/org_1/files?prefix=docs/");
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as {
      files: Array<{ id: string; path: string }>;
    };
    expect(list.files).toEqual([
      expect.objectContaining({ id: first.id, path: "docs/readme.txt" }),
    ]);

    const infoResponse = await app.request(`/v1/orgs/org_1/files/${first.id}`);
    expect(infoResponse.status).toBe(200);
    expect(await infoResponse.json()).toEqual(
      expect.objectContaining({
        status: "ok",
        id: first.id,
        filename: "upload.txt",
        mime_type: "text/plain",
      }),
    );

    const downloadResponse = await app.request(
      `/v1/orgs/org_1/files/${first.id}/content`,
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe("text/plain");
    expect(await downloadResponse.text()).toBe("streamed content");

    expect(
      (
        await app.request(`/v1/orgs/org_1/files/${first.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    expect((await app.request(`/v1/orgs/org_1/files/${first.id}`)).status).toBe(
      404,
    );
  });

  test("rejects duplicate paths, base64 JSON uploads, and oversized files", async () => {
    const storage = new MemoryStorage();
    const { app } = createFilesApp(storage, 8);

    expect(
      (await app.fetch(uploadRequest("same.txt", "12345678"))).status,
    ).toBe(201);
    expect((await app.fetch(uploadRequest("same.txt", "tiny"))).status).toBe(
      409,
    );

    const jsonResponse = await app.request("/v1/orgs/org_1/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "old.txt", content_base64: "b2xk" }),
    });
    expect(jsonResponse.status).toBe(400);

    const tooLarge = await app.fetch(uploadRequest("large.txt", "123456789"));
    expect(tooLarge.status).toBe(413);
  });

  test("requires an authenticated organization session", async () => {
    const config = loadConfig({});
    const services = {
      auth: { api: { getSession: mock().mockResolvedValue(null) } },
      prisma: {},
      storage: new MemoryStorage(),
      database: {},
    };
    const app = createApp({ config, services: services as never });

    const response = await app.fetch(uploadRequest("private.txt", "private"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: "Unauthorized" }),
    );
  });

  test("streams a large upload with bounded memory instead of buffering it", async () => {
    const fileSize = 64 * 1024 * 1024;
    const chunkSize = 64 * 1024;
    const totalChunks = fileSize / chunkSize;
    let producedChunks = 0;
    let firstConsumedAtProduced: number | undefined;
    let peakRss = 0;
    let consumedBytes = 0;
    let largestChunk = 0;

    const storage: Storage = {
      async write(_key, content) {
        for await (const chunk of chunks(content)) {
          firstConsumedAtProduced ??= producedChunks;
          consumedBytes += chunk.byteLength;
          largestChunk = Math.max(largestChunk, chunk.byteLength);
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }
      },
      async read() {
        return null;
      },
      async delete() {},
    };
    const { app } = createFilesApp(storage, fileSize);

    const boundary = "lastsaas-stream-boundary";
    const encoder = new TextEncoder();
    const preamble = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\nlarge.bin\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
    );
    const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);
    const payloadChunk = new Uint8Array(chunkSize);
    let stage: "preamble" | "content" | "epilogue" | "done" = "preamble";
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (stage === "preamble") {
          controller.enqueue(preamble);
          stage = "content";
        } else if (stage === "content" && producedChunks < totalChunks) {
          controller.enqueue(payloadChunk);
          producedChunks += 1;
          if (producedChunks === totalChunks) stage = "epilogue";
        } else if (stage === "epilogue") {
          controller.enqueue(epilogue);
          stage = "done";
        } else {
          controller.close();
        }
      },
    });

    Bun.gc(true);
    const baselineRss = process.memoryUsage().rss;
    peakRss = baselineRss;
    const request = new Request("http://localhost/v1/orgs/org_1/files", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: "half",
    } as RequestInit);
    const response = await app.fetch(request);

    expect(response.status).toBe(201);
    expect(consumedBytes).toBe(fileSize);
    expect(firstConsumedAtProduced).toBeLessThan(totalChunks / 4);
    expect(largestChunk).toBeLessThan(fileSize / 16);
    expect(peakRss - baselineRss).toBeLessThan(fileSize);
  });
});

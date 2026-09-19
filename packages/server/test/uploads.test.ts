import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { createServices, closeServices } from "../src/services";
import { bootstrapOrgPolicies } from "../src/db/casbin";
import {
  createUpload,
  prepareUpload,
  writeUpload,
  completeUpload,
  getUpload,
} from "../src/uploads";
import { createApp } from "../src/app";
import { S3Storage } from "../src/storage/s3";
import { testMigrationSql } from "./test-migrations";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-uploads-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: `file:${directory}/test.db`,
    STORAGE_PATH: `${directory}/files`,
    BETTER_AUTH_URL: "http://localhost:3000",
    MAX_UPLOAD_SIZE: "1024",
  });
  const services = await createServices(config);
  services.database!.exec(testMigrationSql);
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  await services.prisma.user.create({
    data: { id: "user", name: "Uploader", email: "upload@example.com" },
  });
  await services.prisma.organization.create({
    data: { id: "org", name: "Test", slug: "test" },
  });
  await services.prisma.member.create({
    data: {
      id: "member",
      userId: "user",
      organizationId: "org",
      role: "admin",
    },
  });
  await bootstrapOrgPolicies(services.prisma, "org", "user");
  const session = await createUpload(services, config, "org", "user");
  const current = () =>
    getUpload(services, session.upload_id, { token: session.token });
  return { services, config, session, current };
}

test("local uploads stream bytes, remain hidden until completion, and complete once", async () => {
  const { services, config, session, current } = await setup();
  const target = await prepareUpload(
    services,
    config,
    await current(),
    session.token,
    { filename: "notes.txt", size_bytes: 5, mime_type: "text/plain" },
  );
  expect(target.upload_url).toEndWith(`/uploads/${session.upload_id}/content`);
  expect(target.headers.Authorization).toBe(`Bearer ${session.token}`);
  await expect(completeUpload(services, await current())).rejects.toThrow(
    "before completing",
  );
  await writeUpload(services, await current(), new Blob(["hello"]).stream());
  expect(await services.prisma.file.count()).toBe(0);
  const first = await completeUpload(services, await current());
  expect(first.size_bytes).toBe(5);
  expect(
    await new Response(await services.storage.read(`org/${first.id}`)).text(),
  ).toBe("hello");
  expect(await completeUpload(services, await current())).toEqual(first);
  expect(
    await services.prisma.auditLog.count({ where: { action: "upload_file" } }),
  ).toBe(1);
  await expect(
    writeUpload(services, await current(), new Blob(["other"]).stream()),
  ).rejects.toThrow("complete");
});

test("upload credentials are scoped, expire, and respect revoked membership", async () => {
  const { services, session, current } = await setup();
  await expect(
    getUpload(services, session.upload_id, { token: "wrong" }),
  ).rejects.toThrow("not found");
  await expect(
    getUpload(services, session.upload_id, { orgId: "other", userId: "user" }),
  ).rejects.toThrow("not found");
  await services.prisma.member.delete({ where: { id: "member" } });
  await expect(current()).rejects.toThrow("permission");
  await services.prisma.fileUpload.update({
    where: { id: session.upload_id },
    data: { expiresAt: new Date(0) },
  });
  await expect(current()).rejects.toThrow("expired");
});

test("upload sizes and paths are enforced before publishing files", async () => {
  const { services, config, session, current } = await setup();
  await expect(
    prepareUpload(services, config, await current(), session.token, {
      filename: "file",
      size_bytes: 1025,
    }),
  ).rejects.toThrow("limit");
  await expect(
    prepareUpload(services, config, await current(), session.token, {
      filename: "file",
      size_bytes: 3,
      path: "../escape",
    }),
  ).rejects.toThrow("relative");
  await prepareUpload(services, config, await current(), session.token, {
    filename: "file",
    size_bytes: 3,
  });
  await expect(
    writeUpload(services, await current(), new Blob(["toolarge"]).stream()),
  ).rejects.toThrow("larger");
  await expect(
    writeUpload(services, await current(), new Blob(["x"]).stream()),
  ).rejects.toThrow("size");
  expect(
    await services.storage.stat(`uploads/${session.upload_id}`),
  ).toBeNull();
  expect(await services.prisma.file.count()).toBe(0);
});

test("browser link uploads one file with no login and expires after five minutes", async () => {
  const { services, config, session } = await setup();
  const app = createApp({ services, config });
  const base = `/uploads/${session.upload_id}`;
  expect(
    session.upload.expiresAt.getTime() - session.upload.createdAt.getTime(),
  ).toBeLessThanOrEqual(300_000);
  const page = await app.request(base);
  expect(page.ok).toBe(true);
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await page.text()).toContain('type="file"');
  expect((await app.request(base + "/status")).status).toBe(404);
  const headers = {
    Authorization: `Bearer ${session.token}`,
    "Content-Type": "application/json",
  };
  const status = await app.request(base + "/status", { headers });
  expect((await status.json()).organization).toBe("Test");
  const prepared = await app.request(base + "/prepare", {
    method: "POST",
    headers,
    body: JSON.stringify({ filename: "notes.txt", size_bytes: 5 }),
  });
  expect(prepared.ok).toBe(true);
  const target = await prepared.json();
  expect(
    (
      await app.request(target.upload_url, {
        method: "PUT",
        headers: target.headers,
        body: "hello",
      })
    ).status,
  ).toBe(204);
  const completed = await app.request(base + "/complete", {
    method: "POST",
    headers,
  });
  expect(completed.ok).toBe(true);
  expect((await completed.json()).file.filename).toBe("notes.txt");
  expect(
    (
      await app.request(target.upload_url, {
        method: "PUT",
        headers: target.headers,
        body: "again",
      })
    ).status,
  ).toBe(409);
});

test("S3 signs the temporary key and length, then verifies and conditionally copies to the final key", async () => {
  const { services, config, session, current } = await setup();
  const objects = new Map<string, string>();
  const copied: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const key = decodeURIComponent(url.pathname);
      const source = request.headers.get("x-amz-copy-source");
      if (source) {
        expect(request.headers.get("x-amz-copy-source-if-match")).toBe(
          '"etag"',
        );
        const value = objects.get("/" + source.replace(/^\//, ""));
        if (value === undefined) return new Response(null, { status: 404 });
        objects.set(key, value);
        copied.push(key);
        return new Response(
          '<CopyObjectResult><ETag>"etag"</ETag></CopyObjectResult>',
          { headers: { "Content-Type": "application/xml" } },
        );
      }
      if (request.method === "PUT") {
        objects.set(key, await request.text());
        return new Response(null);
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (!objects.has(key)) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : objects.get(key), {
        headers: {
          "Content-Length": String(objects.get(key)!.length),
          ETag: '"etag"',
        },
      });
    },
  });
  try {
    services.storage = new S3Storage({
      bucket: "bucket",
      endpoint: server.url.toString(),
      forcePathStyle: true,
      accessKeyId: "test",
      secretAccessKey: "test",
    });
    const target = await prepareUpload(
      services,
      config,
      await current(),
      session.token,
      { filename: "notes.txt", size_bytes: 5, mime_type: "text/plain" },
    );
    const url = new URL(target.upload_url);
    expect(url.pathname).toBe(`/bucket/uploads/${session.upload_id}`);
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(
      300,
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-length",
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-type",
    );
    await fetch(target.upload_url, {
      method: "PUT",
      headers: target.headers,
      body: "hello",
    });
    await completeUpload(services, await current());
    expect(copied).toEqual([`/bucket/org/${session.upload_id}`]);
    // Reusing the presigned URL can only recreate a temporary object.
    await fetch(target.upload_url, {
      method: "PUT",
      headers: target.headers,
      body: "other",
    });
    expect(objects.get(`/bucket/org/${session.upload_id}`)).toBe("hello");
  } finally {
    await server.stop(true);
  }
});

import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { createServices, closeServices } from "../src/services";
import { bootstrapOrgPolicies } from "../src/db/casbin";
import { createApp } from "../src/app";
import { createDownloadLink } from "../src/file-downloads";
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
  await services.prisma.organization.create({
    data: { id: "other", name: "Other", slug: "other" },
  });
  await services.prisma.file.create({
    data: {
      id: "file",
      orgId: "org",
      filename: 'café "notes".txt',
      path: "notes.txt",
      sizeBytes: 5,
      uploadedBy: "user",
      mimeType: "text/plain",
    },
  });
  await services.storage.write("org/file", new Blob(["hello"]).stream());
  const app = createApp({ services, config });
  return { services, config, app };
}

test("local links download without login, preserve filenames, and allow retries", async () => {
  const { services, config, app } = await setup();
  const link = await createDownloadLink(
    services,
    config,
    "org",
    "user",
    "file",
  );
  expect(Date.parse(link.expires_at) - Date.now()).toBeGreaterThan(298_000);
  expect(Date.parse(link.expires_at) - Date.now()).toBeLessThanOrEqual(300_000);
  for (let i = 0; i < 2; i++) {
    const response = await app.request(link.download_url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''caf%C3%A9%20%22notes%22.txt",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe("hello");
  }
  const token = new URL(link.download_url).searchParams.get("token")!;
  expect(
    (await app.request("/file-downloads/other?token=" + token)).status,
  ).toBe(404);
  expect(
    (await app.request("/file-downloads/file?token=x" + token)).status,
  ).toBe(404);
  expect((await app.request("/file-downloads/file")).status).toBe(404);
  const time = spyOn(Date, "now").mockReturnValue(Date.parse(link.expires_at));
  try {
    expect((await app.request(link.download_url)).status).toBe(410);
  } finally {
    time.mockRestore();
  }
});

test("links enforce organization access and revoked membership", async () => {
  const { services, config, app } = await setup();
  await services.prisma.user.create({
    data: { id: "unprivileged", name: "Member", email: "member@example.com" },
  });
  await services.prisma.member.create({
    data: {
      id: "unprivileged-member",
      userId: "unprivileged",
      organizationId: "org",
      role: "member",
    },
  });
  await expect(
    createDownloadLink(services, config, "org", "unprivileged", "file"),
  ).rejects.toThrow("permission");
  await expect(
    createDownloadLink(services, config, "other", "user", "file"),
  ).rejects.toThrow("permission");
  await expect(
    createDownloadLink(services, config, "org", "user", "missing"),
  ).rejects.toThrow("File not found");
  await services.prisma.file.create({
    data: {
      id: "other-file",
      orgId: "other",
      filename: "secret",
      path: "secret",
      uploadedBy: "user",
    },
  });
  await expect(
    createDownloadLink(services, config, "org", "user", "other-file"),
  ).rejects.toThrow("File not found");
  const link = await createDownloadLink(
    services,
    config,
    "org",
    "user",
    "file",
  );
  await services.prisma.member.delete({ where: { id: "member" } });
  expect((await app.request(link.download_url)).status).toBe(403);
  await expect(
    createDownloadLink(services, config, "org", "user", "file"),
  ).rejects.toThrow("permission");
});

test("S3 download links sign GET, expiry, attachment filename and cache policy", async () => {
  const { services, config } = await setup();
  const storage = new S3Storage({
    bucket: "download-test",
    region: "us-west-2",
    accessKeyId: "test",
    secretAccessKey: "test",
  });
  const link = await createDownloadLink(
    { ...services, storage },
    config,
    "org",
    "user",
    "file",
  );
  const url = new URL(link.download_url);
  expect(url.pathname).toBe("/org/file");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  expect(url.searchParams.get("x-id")).toBe("GetObject");
  expect(url.searchParams.get("response-content-disposition")).toContain(
    "attachment;",
  );
  expect(url.searchParams.get("response-content-disposition")).toContain(
    "filename*=UTF-8''caf%C3%A9",
  );
  expect(url.searchParams.get("response-content-type")).toBe(
    "application/octet-stream",
  );
  expect(url.searchParams.get("response-cache-control")).toBe(
    "private, no-store",
  );
});

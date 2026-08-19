import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStorage, loadConfig } from "../src/config";
import { LocalStorage } from "../src/storage/local";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "lastsaas-storage-"));
  temporaryDirectories.push(path);
  return path;
}

async function* chunked(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield new TextEncoder().encode(chunk);
}

describe("LocalStorage", () => {
  test("streams async-iterable content to disk and reads it as a stream", async () => {
    const baseDirectory = await temporaryDirectory();
    const storage = new LocalStorage(baseDirectory);

    await storage.write(
      "org/files/example.txt",
      chunked("hello", " ", "world"),
    );

    expect(
      await readFile(join(baseDirectory, "org/files/example.txt"), "utf8"),
    ).toBe("hello world");
    const content = await storage.read("org/files/example.txt");
    expect(content).not.toBeNull();
    expect(await new Response(content).text()).toBe("hello world");
  });

  test("accepts a Web ReadableStream without collecting it first", async () => {
    const storage = new LocalStorage(await temporaryDirectory());
    const content = new Blob(["streamed content"]).stream();

    await storage.write("web-stream.txt", content);

    expect(
      await new Response(await storage.read("web-stream.txt")).text(),
    ).toBe("streamed content");
  });

  test("returns null for missing keys and makes deletion idempotent", async () => {
    const storage = new LocalStorage(await temporaryDirectory());

    expect(await storage.read("missing.txt")).toBeNull();
    await storage.delete("missing.txt");
    await storage.write("present.txt", chunked("content"));
    await storage.delete("present.txt");
    expect(await storage.read("present.txt")).toBeNull();
  });

  test("rejects keys that escape the configured directory", async () => {
    const storage = new LocalStorage(await temporaryDirectory());

    await expect(
      storage.write("../outside.txt", chunked("bad")),
    ).rejects.toThrow("escapes the base directory");
    await expect(storage.read("/absolute.txt")).rejects.toThrow(
      "escapes the base directory",
    );
  });
});

describe("storage configuration", () => {
  test("selects local storage by default and parses S3 settings", async () => {
    const storagePath = await temporaryDirectory();
    const local = loadConfig({ STORAGE_PATH: storagePath });
    expect(local.storageType).toBe("local");
    expect(await createStorage(local)).toBeInstanceOf(LocalStorage);

    const s3 = loadConfig({
      STORAGE_TYPE: "s3",
      S3_BUCKET: "files",
      S3_FORCE_PATH_STYLE: "true",
    });
    expect(s3.storageType).toBe("s3");
    expect(s3.s3Bucket).toBe("files");
    expect(s3.s3ForcePathStyle).toBe(true);
  });
});

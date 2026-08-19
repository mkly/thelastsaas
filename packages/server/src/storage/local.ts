import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Storage, StorageInput } from "./interface";

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function asAsyncIterable(content: StorageInput): AsyncIterable<Uint8Array> {
  return content as AsyncIterable<Uint8Array>;
}

export class LocalStorage implements Storage {
  private readonly baseDirectory: string;

  constructor(baseDirectory: string) {
    this.baseDirectory = resolve(baseDirectory);
  }

  private keyToPath(key: string): string {
    if (!key) throw new Error("Storage keys must not be empty");

    const path = resolve(this.baseDirectory, key);
    const pathFromBase = relative(this.baseDirectory, path);
    if (
      pathFromBase === "" ||
      pathFromBase === ".." ||
      pathFromBase.startsWith(`..${sep}`) ||
      isAbsolute(pathFromBase)
    ) {
      throw new Error(`Storage key escapes the base directory: ${key}`);
    }
    return path;
  }

  async write(key: string, content: StorageInput): Promise<void> {
    const path = this.keyToPath(key);
    await mkdir(dirname(path), { recursive: true });

    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await pipeline(
        Readable.from(asAsyncIterable(content)),
        createWriteStream(temporaryPath, { flags: "wx" }),
      );
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch((cleanupError: unknown) => {
        if (!isMissingFile(cleanupError)) throw cleanupError;
      });
      throw error;
    }
  }

  async read(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const path = this.keyToPath(key);
    try {
      await stat(path);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }

    return Readable.toWeb(
      createReadStream(path),
    ) as unknown as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.keyToPath(key));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

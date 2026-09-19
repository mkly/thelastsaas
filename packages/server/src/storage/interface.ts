/** Storage-agnostic file interface. Keys are relative paths within a backend. */

export type StorageInput =
  ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface Storage {
  write(key: string, content: StorageInput): Promise<void>;
  read(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<{ size: number; etag?: string } | null>;
  promote(source: string, destination: string, etag?: string): Promise<void>;
  presignUpload?(
    key: string,
    size: number,
    mimeType: string,
    expiresIn: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
}

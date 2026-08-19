/** Storage-agnostic file interface. Keys are relative paths within a backend. */

export type StorageInput =
  ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface Storage {
  write(key: string, content: StorageInput): Promise<void>;
  read(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
}

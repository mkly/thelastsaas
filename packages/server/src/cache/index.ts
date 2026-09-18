/** Values must be JSON-serializable. Adapters return independent copies.
 * Invalidation must prevent an older in-flight load from repopulating a key.
 * A Redis adapter must provide the same guarantee across server processes.
 */
export interface Cache {
  remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  invalidate(...keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

type Entry = { json: string; expiresAt: number; bytes: number };

/** Bounded LRU, without timers or an unbounded map of pending loads. */
export class MemoryCache implements Cache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private generation = 0;

  constructor(
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxEntries = 10_000,
    private readonly now = Date.now,
  ) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 0
    )
      throw new Error("Cache limits must be nonnegative safe integers");
  }

  get sizeBytes(): number {
    return this.bytes;
  }
  get size(): number {
    return this.entries.size;
  }

  async remember<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    if (!this.maxBytes || !this.maxEntries || ttlMs <= 0) return load();
    const entry = this.entries.get(key);
    if (entry) {
      this.remove(key);
      if (entry.expiresAt > this.now()) {
        this.entries.set(key, entry);
        this.bytes += entry.bytes;
        return JSON.parse(entry.json) as T;
      }
    }
    const generation = this.generation;
    const value = await load();
    // A write finished while this read was in flight. Do not retain its result.
    if (generation !== this.generation) return value;
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    // Conservative accounting for string storage, key and map/entry overhead.
    // This is a cache budget, not a limit on total process RSS or transient loads.
    const bytes =
      2 * (key.length + json.length) + Buffer.byteLength(json) + 256;
    if (bytes > this.maxBytes) return value;
    this.remove(key);
    while (
      this.bytes + bytes > this.maxBytes ||
      this.entries.size >= this.maxEntries
    ) {
      this.remove(this.entries.keys().next().value!);
    }
    this.entries.set(key, { json, bytes, expiresAt: this.now() + ttlMs });
    this.bytes += bytes;
    return value;
  }

  async invalidate(...keys: string[]): Promise<void> {
    this.generation++;
    for (const key of keys) this.remove(key);
  }

  async clear(): Promise<void> {
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.entries.delete(key);
    }
  }
}

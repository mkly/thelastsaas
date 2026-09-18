import { expect, test } from "bun:test";
import { MemoryCache } from "../src/cache";

test("cache isolates values and expires entries without extending TTL on reads", async () => {
  let now = 0;
  const cache = new MemoryCache(4096, 10, () => now);
  let calls = 0;
  const load = async () => ({ nested: { value: ++calls } });
  (await cache.remember("key", 10, load)).nested.value = 99;
  now = 5;
  expect(await cache.remember("key", 10, load)).toEqual({
    nested: { value: 1 },
  });
  now = 10;
  expect(await cache.remember("key", 10, load)).toEqual({
    nested: { value: 2 },
  });
});

test("cache enforces byte and entry budgets with LRU eviction and oversized bypass", async () => {
  const cache = new MemoryCache(1000, 2);
  const read = (key: string) => cache.remember(key, 1000, async () => key);
  await read("a");
  await read("b");
  await read("a");
  await read("c");
  let loaded = false;
  await cache.remember("a", 1000, async () => {
    loaded = true;
    return "a";
  });
  expect(loaded).toBe(false);
  await cache.remember("b", 1000, async () => {
    loaded = true;
    return "b";
  });
  expect(loaded).toBe(true);
  for (let i = 0; i < 100; i++) {
    await read(String(i));
    expect(cache.sizeBytes).toBeLessThanOrEqual(1000);
    expect(cache.size).toBeLessThanOrEqual(2);
  }
  const size = cache.sizeBytes;
  await cache.remember("oversized", 1000, async () => "x".repeat(1000));
  expect(cache.sizeBytes).toBe(size);
  await cache.clear();
  expect(cache.sizeBytes).toBe(0);
  expect(cache.size).toBe(0);
});

test("byte budget alone evicts entries before the entry cap", async () => {
  const cache = new MemoryCache(600, 1000);
  for (let i = 0; i < 100; i++) {
    await cache.remember(String(i), 1000, async () => "x".repeat(60));
    expect(cache.sizeBytes).toBeLessThanOrEqual(600);
    expect(cache.size).toBe(1);
  }
});

test("invalidation prevents a stale in-flight read from repopulating the cache", async () => {
  const cache = new MemoryCache();
  let finish!: (value: string) => void;
  const oldRead = cache.remember(
    "key",
    1000,
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  await cache.invalidate("key");
  await cache.remember("key", 1000, async () => "new");
  finish("old");
  expect(await oldRead).toBe("old");
  expect(await cache.remember("key", 1000, async () => "unexpected")).toBe(
    "new",
  );
});

test("disabled cache and failed loaders retain no entries", async () => {
  const disabled = new MemoryCache(0);
  let calls = 0;
  await disabled.remember("key", 1000, async () => ++calls);
  await disabled.remember("key", 1000, async () => ++calls);
  expect(calls).toBe(2);
  expect(disabled.size).toBe(0);
  const cache = new MemoryCache();
  await expect(
    cache.remember("key", 1000, async () => {
      throw new Error("DB failed");
    }),
  ).rejects.toThrow("DB failed");
  expect(cache.size).toBe(0);
  expect(await cache.remember("key", 1000, async () => "recovered")).toBe(
    "recovered",
  );
});

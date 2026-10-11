import { describe, expect, test } from "bun:test";
import {
  AutomationUnavailableError,
  type SecretKeyring,
} from "@lastsaas/shared";
import { loadConfig } from "../src/config";
import { decryptSecret, encryptSecret } from "../src/secrets/crypto";

const key = Buffer.alloc(32, 17);
const otherKey = Buffer.alloc(32, 29);
const identity = { orgId: "org-one", id: "secret-one" };
const keyring: SecretKeyring = {
  activeVersion: "v1",
  keys: new Map([
    ["v1", key],
    ["v2", otherKey],
    ["same-key", key],
  ]),
};
const value = "private-credential-秘密";

function safeFailure(operation: () => unknown) {
  try {
    operation();
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AutomationUnavailableError);
    const diagnostic = String(error) + JSON.stringify(error);
    expect(diagnostic).not.toContain(value);
    expect(diagnostic).not.toContain(key.toString("base64"));
  }
}

function tamper(encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  bytes[0] ^= 1;
  return bytes.toString("base64");
}

describe("secret authenticated encryption", () => {
  test.each(["", value, "a".repeat(65536)])(
    "roundtrips UTF-8 including empty and maximum values (%#)",
    (plaintext) => {
      const encrypted = encryptSecret(keyring, identity, plaintext);
      expect(decryptSecret(keyring, identity, encrypted)).toBe(plaintext);
      expect(Buffer.from(encrypted.nonce, "base64").length).toBe(12);
      expect(Buffer.from(encrypted.authTag, "base64").length).toBe(16);
      expect(Object.keys(encrypted).sort()).toEqual([
        "authTag",
        "ciphertext",
        "keyVersion",
        "nonce",
      ]);
    },
  );

  test("encrypting the same value uses distinct random nonces", () => {
    const a = encryptSecret(keyring, identity, value);
    const b = encryptSecret(keyring, identity, value);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("rejects wrong key, organization, ID and version without exposing inputs", () => {
    const encrypted = encryptSecret(keyring, identity, value);
    safeFailure(() =>
      decryptSecret(
        { activeVersion: "v1", keys: new Map([["v1", otherKey]]) },
        identity,
        encrypted,
      ),
    );
    safeFailure(() =>
      decryptSecret(keyring, { ...identity, orgId: "other" }, encrypted),
    );
    safeFailure(() =>
      decryptSecret(keyring, { ...identity, id: "other" }, encrypted),
    );
    safeFailure(() =>
      decryptSecret(keyring, identity, {
        ...encrypted,
        keyVersion: "same-key",
      }),
    );
    // Tuple encoding distinguishes identities that ambiguous delimiters could conflate.
    const bound = encryptSecret(keyring, { orgId: "a:b", id: "c" }, value);
    safeFailure(() => decryptSecret(keyring, { orgId: "a", id: "b:c" }, bound));
  });

  test.each(["ciphertext", "nonce", "authTag"] as const)(
    "rejects tampered %s",
    (field) => {
      const encrypted = encryptSecret(keyring, identity, value);
      safeFailure(() =>
        decryptSecret(keyring, identity, {
          ...encrypted,
          [field]: tamper(encrypted[field]),
        }),
      );
      safeFailure(() =>
        decryptSecret(keyring, identity, {
          ...encrypted,
          [field]: "invalid base64!",
        }),
      );
    },
  );

  test("rejects truncated nonce/tag and noncanonical encoding", () => {
    const encrypted = encryptSecret(keyring, identity, value);
    safeFailure(() =>
      decryptSecret(keyring, identity, {
        ...encrypted,
        nonce: Buffer.alloc(11).toString("base64"),
      }),
    );
    safeFailure(() =>
      decryptSecret(keyring, identity, {
        ...encrypted,
        authTag: Buffer.alloc(12).toString("base64"),
      }),
    );
    safeFailure(() =>
      decryptSecret(keyring, identity, {
        ...encrypted,
        ciphertext: encrypted.ciphertext + "\n",
      }),
    );
  });

  test("supports explicit versions and retaining old keys after active version changes", () => {
    const old = encryptSecret(keyring, identity, value);
    const rotatedRing = { ...keyring, activeVersion: "v2" };
    expect(decryptSecret(rotatedRing, identity, old)).toBe(value);
    const rotated = encryptSecret(rotatedRing, identity, value);
    expect(rotated.keyVersion).toBe("v2");
    expect(decryptSecret(keyring, identity, rotated)).toBe(value);
    expect(encryptSecret(rotatedRing, identity, value, "v1").keyVersion).toBe(
      "v1",
    );
  });

  test("missing keys and invalid key lengths fail safely", () => {
    const encrypted = encryptSecret(keyring, identity, value);
    safeFailure(() => encryptSecret(null, identity, value));
    safeFailure(() => decryptSecret(null, identity, encrypted));
    safeFailure(() => encryptSecret(keyring, identity, value, "missing"));
    safeFailure(() =>
      decryptSecret(keyring, identity, { ...encrypted, keyVersion: "missing" }),
    );
    for (const length of [0, 16, 31, 33]) {
      safeFailure(() =>
        encryptSecret(
          {
            activeVersion: "v1",
            keys: new Map([["v1", Buffer.alloc(length)]]),
          },
          identity,
          value,
        ),
      );
    }
  });

  test("enforces byte limits, including multi-byte text, without reflecting values", () => {
    for (const oversized of ["a".repeat(65537), "秘".repeat(21846)]) {
      expect(() => encryptSecret(keyring, identity, oversized)).toThrow(
        "Secret exceeds 64 KiB",
      );
    }
    expect(
      decryptSecret(
        keyring,
        identity,
        encryptSecret(keyring, identity, "秘".repeat(21845)),
      ),
    ).toBe("秘".repeat(21845));
  });
});

describe("secret keyring configuration", () => {
  test("absent configuration preserves development and production startup", () => {
    expect(loadConfig({}).secretKeyring).toBeNull();
    expect(
      loadConfig({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "x".repeat(32),
        BETTER_AUTH_URL: "https://example.com",
      }).secretKeyring,
    ).toBeNull();
  });

  test("loads active and retained versions from the frozen environment contract", () => {
    const config = loadConfig({
      SECRETS_ACTIVE_KEY_VERSION: "v2",
      SECRETS_KEYRING: JSON.stringify({
        v1: key.toString("base64"),
        v2: otherKey.toString("base64"),
      }),
    });
    expect(config.secretKeyring!.activeVersion).toBe("v2");
    expect(Buffer.from(config.secretKeyring!.keys.get("v1")!)).toEqual(key);
  });

  test("rejects malformed/partial config without key material in diagnostics", () => {
    const cases = [
      { SECRETS_ACTIVE_KEY_VERSION: "v1" },
      { SECRETS_KEYRING: JSON.stringify({ v1: key.toString("base64") }) },
      { SECRETS_ACTIVE_KEY_VERSION: "", SECRETS_KEYRING: "" },
      ...[
        "{broken",
        "null",
        "[]",
        "{}",
        JSON.stringify({ v2: key.toString("base64") }),
        JSON.stringify({ v1: "bad" }),
        JSON.stringify({ "bad/version": key.toString("base64") }),
        JSON.stringify({ v1: key.toString("base64") + "\n" }),
        ...[16, 31, 33].map((size) =>
          JSON.stringify({ v1: Buffer.alloc(size).toString("base64") }),
        ),
      ].map((encoded) => ({
        SECRETS_ACTIVE_KEY_VERSION: "v1",
        SECRETS_KEYRING: encoded,
      })),
    ];
    for (const environment of cases) {
      try {
        loadConfig(environment);
        throw new Error("Expected invalid configuration");
      } catch (error) {
        expect(String(error)).toContain("Invalid secrets configuration");
        expect(String(error)).not.toContain(key.toString("base64"));
        expect(String(error)).not.toContain(
          environment.SECRETS_KEYRING || "{broken",
        );
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });
});

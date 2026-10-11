import {
  AUTOMATION_LIMITS,
  AutomationUnavailableError,
  SchemaValidationError,
  type SecretKeyring,
} from "@lastsaas/shared";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SecretIdentity {
  orgId: string;
  id: string;
}

/** Persistence fields only. A plaintext value is never part of this object. */
export interface SecretCiphertext {
  keyVersion: string;
  ciphertext: string;
  nonce: string;
  authTag: string;
}

function keyFor(keyring: SecretKeyring | null, version?: string): Uint8Array {
  const key = keyring?.keys.get(version ?? keyring.activeVersion);
  if (!key || key.byteLength !== 32) {
    throw new AutomationUnavailableError(
      "Secret encryption key is unavailable",
    );
  }
  return key;
}

function aad(identity: SecretIdentity, version: string): Buffer {
  // A versioned tuple avoids ambiguous concatenation of organization/secret IDs.
  return Buffer.from(
    JSON.stringify([
      "lastsaas.secret.v1",
      identity.orgId,
      identity.id,
      version,
    ]),
    "utf8",
  );
}

function decode(encoded: string, length?: number): Buffer {
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    (length !== undefined && bytes.length !== length)
  )
    throw new Error();
  return bytes;
}

export function encryptSecret(
  keyring: SecretKeyring | null,
  identity: SecretIdentity,
  value: string,
  keyVersion?: string,
): SecretCiphertext {
  const key = keyFor(keyring, keyVersion);
  const version = keyVersion ?? keyring!.activeVersion;
  const plaintext = Buffer.from(value, "utf8");
  if (plaintext.byteLength > AUTOMATION_LIMITS.secretBytes) {
    throw new SchemaValidationError(["Secret exceeds 64 KiB of UTF-8"]);
  }
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(aad(identity, version));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return {
      keyVersion: version,
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  } catch {
    throw new AutomationUnavailableError("Secret encryption failed");
  } finally {
    plaintext.fill(0);
  }
}

export function decryptSecret(
  keyring: SecretKeyring | null,
  identity: SecretIdentity,
  encrypted: SecretCiphertext,
): string {
  const key = keyFor(keyring, encrypted.keyVersion);
  let plaintext: Buffer | undefined;
  let final: Buffer | undefined;
  try {
    const nonce = decode(encrypted.nonce, 12);
    const tag = decode(encrypted.authTag, 16);
    const ciphertext = decode(encrypted.ciphertext);
    if (ciphertext.byteLength > AUTOMATION_LIMITS.secretBytes)
      throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(aad(identity, encrypted.keyVersion));
    decipher.setAuthTag(tag);
    plaintext = decipher.update(ciphertext);
    // No plaintext escapes until final() has authenticated the entire message.
    final = decipher.final();
    return Buffer.concat([plaintext, final]).toString("utf8");
  } catch {
    throw new AutomationUnavailableError("Secret decryption failed");
  } finally {
    plaintext?.fill(0);
    final?.fill(0);
  }
}

import type { AutomationResponse } from "./automation";
import { z } from "zod";
import {
  AUTOMATION_LIMITS,
  resourceNameSchema,
  type AutomationContext,
  type AutomationPage,
  type PageRequest,
} from "./automation";

const keyVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
export const secretValueSchema = z
  .string()
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <=
      AUTOMATION_LIMITS.secretBytes,
    "Secret exceeds 64 KiB of UTF-8",
  );
export const secretCreateSchema = z.strictObject({
  name: resourceNameSchema,
  value: secretValueSchema,
});
export const secretReplaceSchema = z.strictObject({ value: secretValueSchema });
export const secretRevealSchema = z.strictObject({});
export const secretRotationSchema = z.strictObject({
  key_version: keyVersionSchema,
  limit: z.number().int().min(1).max(100).default(100),
  cursor: z.string().min(1).max(2048).optional(),
});
export type SecretCreate = z.infer<typeof secretCreateSchema>;
export type SecretReplace = z.infer<typeof secretReplaceSchema>;
export type SecretRotation = z.infer<typeof secretRotationSchema>;
export interface SecretMetadata {
  id: string;
  organization_id: string;
  name: string;
  key_version: string;
  created_at: string;
  updated_at: string;
}
export interface SecretReveal {
  id: string;
  name: string;
  value: string;
}
/** Persistence/explicit backup only; never included in ordinary metadata/export. */
export interface EncryptedSecret {
  id: string;
  organization_id: string;
  name: string;
  key_version: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  created_at: string;
  updated_at: string;
}
/** Explicit opt-in; ordinary organization exports contain no secrets. */
export const secretBackupRequestSchema = z.strictObject({
  include_encrypted_secrets: z.boolean().default(false),
});

export const encryptedSecretSchema = z.strictObject({
  id: z.string().min(1).max(128),
  organization_id: z.string().min(1).max(128),
  name: resourceNameSchema,
  key_version: keyVersionSchema,
  ciphertext: z.string().max(87384),
  nonce: z.string().max(24),
  auth_tag: z.string().max(24),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export interface SecretKeyring {
  activeVersion: string;
  keys: ReadonlyMap<string, Uint8Array>;
}
export interface SecretRotationResult {
  rotated: number;
  next_cursor: string | null;
}
export interface SecretService {
  create(
    context: AutomationContext,
    input: SecretCreate,
  ): Promise<SecretMetadata>;
  list(
    context: AutomationContext,
    input: PageRequest,
  ): Promise<AutomationPage<SecretMetadata>>;
  show(context: AutomationContext, name: string): Promise<SecretMetadata>;
  replace(
    context: AutomationContext,
    name: string,
    input: SecretReplace,
  ): Promise<SecretMetadata>;
  delete(context: AutomationContext, name: string): Promise<void>;
  reveal(context: AutomationContext, name: string): Promise<SecretReveal>;
}

/** Canonical base64 encoding of exactly 32 bytes; never log failed config inputs. */
const encryptionKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .refine((value) => {
    try {
      return btoa(atob(value)) === value;
    } catch {
      return false;
    }
  }, "Invalid encryption key");
export const secretKeyringConfigSchema = z
  .strictObject({
    active_version: keyVersionSchema,
    keys: z.record(keyVersionSchema, encryptionKeySchema),
  })
  .refine(
    (value) => Object.hasOwn(value.keys, value.active_version),
    "Active key version is missing",
  );
export type SecretKeyringConfig = z.infer<typeof secretKeyringConfigSchema>;

export type SecretResponse = AutomationResponse<{ secret: SecretMetadata }>;

export type SecretListResponse = AutomationResponse<
  AutomationPage<SecretMetadata>
>;

export type SecretRevealResponse = AutomationResponse<{ secret: SecretReveal }>;

export type SecretRotationResponse = AutomationResponse<SecretRotationResult>;

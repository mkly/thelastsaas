import {
  secretKeyringConfigSchema,
  type SecretKeyring,
} from "@lastsaas/shared";

/** Never retain parser errors: JSON/schema diagnostics can contain key material. */
export function loadSecretKeyring(
  environment: Record<string, string | undefined>,
): SecretKeyring | null {
  const activeVersion = environment.SECRETS_ACTIVE_KEY_VERSION;
  const encodedKeys = environment.SECRETS_KEYRING;
  if (activeVersion === undefined && encodedKeys === undefined) return null;
  try {
    if (activeVersion === undefined || encodedKeys === undefined)
      throw new Error();
    const config = secretKeyringConfigSchema.parse({
      active_version: activeVersion,
      keys: JSON.parse(encodedKeys),
    });
    const keys = new Map<string, Uint8Array>();
    for (const [version, encoded] of Object.entries(config.keys)) {
      const key = Buffer.from(encoded, "base64");
      if (key.byteLength !== 32 || key.toString("base64") !== encoded)
        throw new Error();
      keys.set(version, key);
    }
    return { activeVersion: config.active_version, keys };
  } catch {
    throw new Error(
      "Invalid secrets configuration: provide SECRETS_ACTIVE_KEY_VERSION and SECRETS_KEYRING with canonical base64 32-byte keys and a configured active version",
    );
  }
}

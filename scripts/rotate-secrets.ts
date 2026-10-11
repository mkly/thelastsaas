import { runSecretRotationOperator } from "../packages/server/src/secrets/rotation-operator";

if (import.meta.main) {
  try {
    await runSecretRotationOperator();
  } catch {
    // Never print database/crypto/parser exceptions or submitted operator args.
    console.error(
      "Secret rotation failed. Check database/keyring configuration, and batch arguments; retry with the same cursor.",
    );
    process.exitCode = 1;
  }
}

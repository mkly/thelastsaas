export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
  }
}

export class ReauthenticationRequiredError extends CliError {
  constructor() {
    super(
      "Authentication expired or was rejected. Run `saas login` to re-authenticate.",
    );
    this.name = "ReauthenticationRequiredError";
  }
}

export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Error:") ? message : `Error: ${message}`;
}

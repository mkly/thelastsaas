import { handleResponse } from "../api-client";
import { CliError, ReauthenticationRequiredError } from "../errors";
const failureMessages: Record<number, string> = {
  400: "Invalid secret request.",
  403: "Secret permission denied.",
  404: "Secret not found.",
  409: "Secret name already exists.",
  413: "Secret exceeds 64 KiB of UTF-8.",
  503: "Secrets are unavailable. Check the server encryption key configuration.",
};

// Never echo server diagnostics: an unexpected upstream error may contain input.
export async function handleSecretResponse<T>(response: Response): Promise<T> {
  try {
    return await handleResponse<T>(response);
  } catch (error) {
    if (error instanceof ReauthenticationRequiredError) throw error;
    throw new CliError(
      failureMessages[response.status] ?? "Secret operation failed.",
    );
  }
}

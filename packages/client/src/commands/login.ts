import { DEFAULT_SERVER_URL, loadConfig } from "../config";
import { login as performLogin, type LoginDependencies } from "../auth";
import { writeOutput, type OutputOptions } from "../output";

export interface LoginCommandOptions {
  server?: string;
}

export async function login(
  options: LoginCommandOptions,
  outputOptions: OutputOptions = {},
  dependencies: LoginDependencies = {},
): Promise<void> {
  const server =
    options.server ??
    loadConfig(dependencies.configPath)?.server ??
    DEFAULT_SERVER_URL;
  const result = await performLogin(server, dependencies);

  writeOutput(
    {
      expires_at: result.expiresAt,
      server: result.server,
      status: "ok",
    },
    outputOptions,
    `Logged in successfully to ${result.server}. Run \`saas orgs list\` to view or select an organization.`,
  );
}

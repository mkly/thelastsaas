import type { Command } from "commander";

import { withErrorHandling } from "../api-client";
import { login } from "./login";
import { logout } from "./logout";
import { whoami } from "./whoami";

interface AuthGlobalOptions {
  json?: boolean;
  org?: string;
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description("log in through the browser using PKCE")
    .option("--server <url>", "The Last SaaS server URL")
    .action(
      withErrorHandling(async (options, command: Command) => {
        await login(options, command.optsWithGlobals<AuthGlobalOptions>());
      }),
    );

  program
    .command("whoami")
    .description("show the current server, organization, and session status")
    .action(
      withErrorHandling(async (_options, command: Command) => {
        await whoami(command.optsWithGlobals<AuthGlobalOptions>());
      }),
    );

  program
    .command("logout")
    .description("remove the stored session")
    .action(
      withErrorHandling(async (_options, command: Command) => {
        await logout(command.optsWithGlobals<AuthGlobalOptions>());
      }),
    );
}

#!/usr/bin/env bun

import { Command } from "commander";

import { commandRegistrars, type CommandRegistrar } from "./commands";
import { formatCliError } from "./errors";

export const CLI_VERSION = "0.1.0";

export interface GlobalOptions {
  json?: boolean;
  org?: string;
}

export function createProgram(
  registrars: readonly CommandRegistrar[] = commandRegistrars,
): Command {
  const program = new Command()
    .name("saas")
    .description("CLI client for Last SaaS")
    .version(CLI_VERSION)
    .option("--org <org-id>", "organization ID (defaults to the stored config)")
    .option("--json", "write machine-readable JSON output")
    .showHelpAfterError()
    .showSuggestionAfterError();

  for (const register of registrars) {
    register(program);
  }

  return program;
}

export async function runCli(
  argv: readonly string[] = process.argv,
): Promise<void> {
  await createProgram().parseAsync([...argv]);
}

export function getGlobalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

if (import.meta.main) {
  try {
    await runCli();
  } catch (error) {
    console.error(formatCliError(error));
    process.exitCode = 1;
  }
}

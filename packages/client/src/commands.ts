import type { Command } from "commander";

import { registerAuthCommands } from "./commands/auth";

export type CommandRegistrar = (program: Command) => void;

// Command-family tasks register one function in this list.
export const commandRegistrars: readonly CommandRegistrar[] = [
  registerAuthCommands,
];

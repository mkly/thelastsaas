import type { Command } from "commander";

import { registerAccessCommands } from "./commands/access";

export type CommandRegistrar = (program: Command) => void;

// Command-family tasks register one function in this list.
export const commandRegistrars: readonly CommandRegistrar[] = [
  registerAccessCommands,
];

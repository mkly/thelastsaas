import type { Command } from "commander";

import { registerOperationsCommands } from "./commands/operations";

export type CommandRegistrar = (program: Command) => void;

// Command-family tasks register one function in this list.
export const commandRegistrars: readonly CommandRegistrar[] = [
  registerOperationsCommands,
];

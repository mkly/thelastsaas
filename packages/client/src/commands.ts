import type { Command } from "commander";

import { registerCollections } from "./commands/collections";
import { registerRecords } from "./commands/records";

export type CommandRegistrar = (program: Command) => void;

// Command-family tasks register one function in this list.
export const commandRegistrars: readonly CommandRegistrar[] = [
  registerCollections,
  registerRecords,
];

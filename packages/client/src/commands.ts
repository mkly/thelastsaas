import type { Command } from "commander";

import { registerAccessCommands } from "./commands/access";
import { registerAuthCommands } from "./commands/auth";
import { registerCollections } from "./commands/collections";
import { registerRecords } from "./commands/records";
import { registerSkills } from "./commands/skills";

export type CommandRegistrar = (program: Command) => void;

// Command-family tasks register one function in this list.
export const commandRegistrars: readonly CommandRegistrar[] = [
  registerAuthCommands,
  registerCollections,
  registerRecords,
  registerAccessCommands,
  registerSkills,
];

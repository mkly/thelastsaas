import type { Command } from "commander";

import { registerSkills } from "./commands/skills";

export type CommandRegistrar = (program: Command) => void;

// Command-family tasks register one function in this list.
export const commandRegistrars: readonly CommandRegistrar[] = [registerSkills];

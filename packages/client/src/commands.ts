import type { Command } from "commander";

import { registerAccessCommands } from "./commands/access";
import { registerAuthCommands } from "./commands/auth";
import { registerCollections } from "./commands/collections";
import { registerOperationsCommands } from "./commands/operations";
import { registerOrganizationCommands } from "./commands/orgs";
import { registerRecords } from "./commands/records";
import { registerGettingStarted } from "./commands/getting-started";
import { registerSkills } from "./commands/skills";
import { registerSecrets } from "./commands/secrets";
import { registerQueues } from "./commands/queues";
import { registerTransactions } from "./commands/transactions";
import { registerTriggers } from "./commands/triggers";
import { registerSchedules } from "./commands/schedules";

export type CommandRegistrar = (program: Command) => void;

// Command-family tasks register one function in this list.
export const commandRegistrars: readonly CommandRegistrar[] = [
  registerAuthCommands,
  registerOrganizationCommands,
  registerCollections,
  registerRecords,
  registerAccessCommands,
  registerSkills,
  registerGettingStarted,
  registerOperationsCommands,
  registerSecrets,
  registerQueues,
  registerTransactions,
  registerTriggers,
  registerSchedules,
];

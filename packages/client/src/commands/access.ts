import type { Command } from "commander";

import { registerMembers } from "./members";
import { registerPermissions } from "./permissions";

export function registerAccessCommands(program: Command): void {
  registerPermissions(program);
  registerMembers(program);
}

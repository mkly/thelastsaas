import type { Command } from "commander";

import { registerFiles } from "./files";
import { registerNotifications } from "./notifications";
import { registerSystemCommands } from "./system";

export function registerOperationsCommands(program: Command): void {
  registerFiles(program);
  registerNotifications(program);
  registerSystemCommands(program);
}

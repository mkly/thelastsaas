import { getGettingStartedGuide } from "@lastsaas/shared";
import type { Command } from "commander";
import { writeOutput, type OutputOptions } from "../output";

export function registerGettingStarted(program: Command): void {
  program
    .command("getting-started")
    .description("Read the guided tutorial (no login required)")
    .action((_options, command: Command) => {
      const guide = getGettingStartedGuide("cli");
      writeOutput({ guide }, command.optsWithGlobals<OutputOptions>(), guide);
    });
}

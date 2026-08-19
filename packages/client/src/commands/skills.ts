import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Command } from "commander";

import { SKILL_MD } from "../skill.generated";

export interface SkillsCommandDependencies {
  install(directory?: string): string;
  write(text: string): void;
}

export function defaultSkillsDirectory(): string {
  return join(homedir(), ".lastsaas", "skills");
}

export function installEmbeddedSkill(
  directory = defaultSkillsDirectory(),
): string {
  const skillDirectory = resolve(directory, "lastsaas");
  const destination = join(skillDirectory, "SKILL.md");
  mkdirSync(skillDirectory, { mode: 0o700, recursive: true });
  writeFileSync(destination, SKILL_MD, { mode: 0o600 });
  return destination;
}

const defaultDependencies: SkillsCommandDependencies = {
  install: installEmbeddedSkill,
  write: (text) => process.stdout.write(text),
};

export function registerSkills(
  program: Command,
  dependencies: SkillsCommandDependencies = defaultDependencies,
): void {
  const skills = program
    .command("skills")
    .alias("skill")
    .description("Print or install the bundled Last SaaS agent guide");

  skills
    .command("print")
    .description("Print the bundled guide to stdout")
    .action(() => dependencies.write(SKILL_MD));

  skills
    .command("install")
    .alias("path")
    .description("Install the bundled guide and print its path")
    .option(
      "-d, --directory <path>",
      "skill root directory (a lastsaas subdirectory is created)",
    )
    .action((options: { directory?: string }) => {
      dependencies.write(`${dependencies.install(options.directory)}\n`);
    });
}

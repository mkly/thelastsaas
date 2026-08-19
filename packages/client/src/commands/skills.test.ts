import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { SKILL_MD } from "../skill.generated";
import { installEmbeddedSkill, registerSkills } from "./skills";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("skills commands", () => {
  test("prints the embedded guide", async () => {
    let output = "";
    const program = new Command();
    registerSkills(program, {
      install: () => "/unused",
      write: (text) => {
        output += text;
      },
    });

    await program.parseAsync(["bun", "saas", "skills", "print"]);

    expect(output).toBe(SKILL_MD);
    expect(output).toContain("# Last SaaS Agent Guide");
  });

  test("installs the guide below a caller-selected skill root", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lastsaas-skills-"));
    temporaryDirectories.push(directory);
    let output = "";
    const program = new Command();
    registerSkills(program, {
      install: installEmbeddedSkill,
      write: (text) => {
        output += text;
      },
    });

    await program.parseAsync([
      "bun",
      "saas",
      "skills",
      "install",
      "--directory",
      directory,
    ]);

    const destination = join(directory, "lastsaas", "SKILL.md");
    expect(output).toBe(`${destination}\n`);
    expect(readFileSync(destination, "utf8")).toBe(SKILL_MD);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
  });
});

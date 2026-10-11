import { describe, expect, test } from "bun:test";
import { version } from "../package.json";

import { createProgram, getGlobalOptions } from "./index";

describe("CLI program", () => {
  test("prints the CLI package version for --version", () => {
    let output = "";
    const program = createProgram([])
      .exitOverride()
      .configureOutput({ writeOut: (text) => (output += text) });

    expect(() => program.parse(["bun", "saas", "--version"])).toThrow();
    expect(output).toBe(`${version}\n`);
  });

  test("registers command families from the registry", async () => {
    const program = createProgram([
      (root) => {
        root.command("example").action(() => undefined);
      },
    ]);

    await program.parseAsync(["bun", "saas", "example"]);

    expect(program.commands.map((command) => command.name())).toContain(
      "example",
    );
  });

  test("exposes global authentication, organization, and JSON options to subcommands", async () => {
    let options: ReturnType<typeof getGlobalOptions> | undefined;
    const program = createProgram([
      (root) => {
        root.command("example").action((_options, command) => {
          options = getGlobalOptions(command);
        });
      },
    ]);

    await program.parseAsync([
      "bun",
      "saas",
      "--token",
      "lsk_test",
      "--org",
      "org_123",
      "--json",
      "example",
    ]);

    expect(options).toEqual({
      json: true,
      org: "org_123",
      token: "lsk_test",
    });
  });
});

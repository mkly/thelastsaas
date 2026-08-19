import type { AuditEntry, Stats } from "@lastsaas/shared";
import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseJson, withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import type { GlobalOptions } from "../index";
import {
  defaultOperationsCommandDependencies,
  getOperationsApi,
  type OperationsCommandDependencies,
} from "./operations-client";

export interface SystemCommandDependencies extends OperationsCommandDependencies {
  readTextFile(path: string): string;
  writeTextFile(path: string, content: string): void;
  exists(path: string): boolean;
}

const defaultDependencies: SystemCommandDependencies = {
  ...defaultOperationsCommandDependencies,
  readTextFile: (path) => readFileSync(path, "utf8"),
  writeTextFile: (path, content) => writeFileSync(path, content),
  exists: existsSync,
};

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function auditOutput(entries: AuditEntry[]): string {
  if (entries.length === 0) return "No audit entries.";
  return entries
    .map(
      (entry) =>
        `${entry.created_at}  ${entry.action.padEnd(24)} ${entry.resource_type}:${entry.resource_id ?? "-"}  ${entry.user_id}`,
    )
    .join("\n");
}

function statsOutput(stats: Stats): string {
  return [
    `Collections: ${stats.collections}`,
    `Records:     ${stats.records}`,
    `Files:       ${stats.files}`,
    `Storage:     ${stats.storage_bytes} bytes`,
  ].join("\n");
}

export function registerSystemCommands(
  program: Command,
  dependencies: SystemCommandDependencies = defaultDependencies,
): void {
  program
    .command("audit")
    .description("List organization audit entries")
    .option("--limit <n>", "Maximum entries")
    .option("--action <action>", "Filter by action")
    .option("--resource-type <type>", "Filter by resource type")
    .action(
      withErrorHandling(
        async (
          commandOptions: {
            limit?: string;
            action?: string;
            resourceType?: string;
          },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[":orgId"][
            "audit-log"
          ].$get({
            param: { orgId },
            query: {
              ...(commandOptions.limit ? { limit: commandOptions.limit } : {}),
              ...(commandOptions.action
                ? { action: commandOptions.action }
                : {}),
              ...(commandOptions.resourceType
                ? { resource_type: commandOptions.resourceType }
                : {}),
            },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            entries: AuditEntry[];
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            auditOutput(result.entries),
          );
        },
      ),
    );

  program
    .command("stats")
    .description("Show organization statistics")
    .action(
      withErrorHandling(async (_commandOptions, command: Command) => {
        const options = globalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const response = await getOperationsApi(client).v1.orgs[
          ":orgId"
        ].stats.$get({ param: { orgId } });
        const result = await dependencies.handleResponse<
          Stats & { status: "ok" }
        >(response);
        dependencies.writeOutput(result, options, statsOutput(result));
      }),
    );

  program
    .command("export")
    .description("Export a portable organization dump")
    .option("-o, --output <path>", "Write the dump to a file")
    .option("--force", "Overwrite an existing output file")
    .action(
      withErrorHandling(
        async (
          commandOptions: { output?: string; force?: boolean },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].export.$post({ param: { orgId } });
          const result = await dependencies.handleResponse(response);
          if (!commandOptions.output) {
            dependencies.writeOutput(result, { json: true });
            return;
          }
          const outputPath = resolve(commandOptions.output);
          if (!commandOptions.force && dependencies.exists(outputPath)) {
            throw new CliError(
              `Refusing to overwrite '${outputPath}'. Pass --force to replace it.`,
            );
          }
          dependencies.writeTextFile(
            outputPath,
            `${JSON.stringify(result, null, 2)}\n`,
          );
          dependencies.writeOutput(
            { status: "ok", output: outputPath },
            options,
            `Exported organization to ${outputPath}`,
          );
        },
      ),
    );

  program
    .command("import <path>")
    .description("Import a portable organization dump")
    .action(
      withErrorHandling(
        async (path: string, _commandOptions, command: Command) => {
          if (!dependencies.exists(path)) {
            throw new CliError(`Import file '${path}' does not exist.`);
          }
          const dump = parseJson<Record<string, unknown>>(
            dependencies.readTextFile(path),
            "Import file",
          );
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].import.$post({ param: { orgId }, json: dump });
          const result = await dependencies.handleResponse<{
            status: "ok";
            imported_collections: number;
            imported_records: number;
            imported_files?: number;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            `Imported ${result.imported_collections} collections, ${result.imported_records} records, and ${result.imported_files ?? 0} files`,
          );
        },
      ),
    );
}

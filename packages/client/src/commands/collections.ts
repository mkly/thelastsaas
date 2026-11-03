import type { CollectionValidation, Schema } from "@lastsaas/shared";
import type { Command } from "commander";

import { parseJson, withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import type { GlobalOptions } from "../index";
import {
  defaultDataCommandDependencies,
  getDataApi,
  type DataCommandDependencies,
} from "./data-client";

interface CollectionSummary {
  id: string;
  name: string;
  schema: Schema;
  description?: string;
  validations?: CollectionValidation[];
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

export function registerCollections(
  program: Command,
  dependencies: DataCommandDependencies = defaultDataCommandDependencies,
): void {
  const collections = program
    .command("collections")
    .alias("c")
    .description("Manage collections");

  collections
    .command("list")
    .alias("ls")
    .description("List all collections")
    .action(
      withErrorHandling(async (_options: unknown, command: Command) => {
        const options = globalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const response = await getDataApi(client).v1.orgs[
          ":orgId"
        ].collections.$get({ param: { orgId } });
        const result = await dependencies.handleResponse<{
          status: "ok";
          collections: CollectionSummary[];
        }>(response);

        const human =
          result.collections.length === 0
            ? "No collections."
            : result.collections
                .map((collection) => {
                  const fields = Object.keys(collection.schema).length;
                  const description = collection.description
                    ? ` — ${collection.description}`
                    : "";
                  return `  ${collection.name.padEnd(24)} ${String(fields).padStart(2)} fields${description}`;
                })
                .join("\n");
        dependencies.writeOutput(result, options, human);
      }),
    );

  collections
    .command("create <name>")
    .description("Create a new collection")
    .requiredOption("-s, --schema <json>", "Schema as JSON")
    .option("-d, --description <text>", "Collection description")
    .option("--validations <json>", "Collection validation rules as JSON")
    .action(
      withErrorHandling(
        async (
          name: string,
          commandOptions: {
            schema: string;
            description?: string;
            validations?: string;
          },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const schema = parseJson<Schema>(commandOptions.schema, "--schema");
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getDataApi(client).v1.orgs[
            ":orgId"
          ].collections.$post({
            param: { orgId },
            json: {
              name,
              schema,
              description: commandOptions.description ?? "",
              ...(commandOptions.validations === undefined
                ? {}
                : {
                    validations: parseJson<CollectionValidation[]>(
                      commandOptions.validations,
                      "--validations",
                    ),
                  }),
            },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            policies?: Array<{
              resource: string;
              action: string;
              cond: string;
              msg: string;
            }>;
            id: string;
            name: string;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            `Created collection '${result.name}' (${result.id})`,
          );
        },
      ),
    );

  collections
    .command("describe <name>")
    .alias("desc")
    .description("Show collection details")
    .action(
      withErrorHandling(async (name: string, _options, command: Command) => {
        const options = globalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const response = await getDataApi(client).v1.orgs[":orgId"].collections[
          ":name"
        ].$get({ param: { orgId, name } });
        const result = await dependencies.handleResponse<
          CollectionSummary & {
            status: "ok";
            policies?: Array<{
              resource: string;
              action: string;
              cond: string;
              msg: string;
            }>;
          }
        >(response);

        const lines = [result.name];
        if (result.description) lines.push(`  ${result.description}`);
        lines.push("", "Schema:");
        const entries = Object.entries(result.schema);
        if (entries.length === 0) {
          lines[lines.length - 1] = "Schema: (empty)";
        } else {
          for (const [field, definition] of entries) {
            const rendered =
              typeof definition === "string"
                ? definition
                : JSON.stringify(definition);
            lines.push(`  ${field.padEnd(24)} ${rendered}`);
          }
        }
        if (result.validations?.length) {
          lines.push(
            "",
            "Validations:",
            ...result.validations.map(
              (rule) =>
                `  ${rule.name}: ${"rule" in rule ? rule.rule : JSON.stringify(rule)} — ${rule.message}`,
            ),
          );
        }
        if (result.policies?.length)
          lines.push(
            "",
            "Policies:",
            ...result.policies.map(
              (policy) =>
                `  ${policy.action} ${policy.resource}: ${policy.cond}${policy.msg ? ` — ${policy.msg}` : ""}`,
            ),
          );
        dependencies.writeOutput(result, options, lines.join("\n"));
      }),
    );

  collections
    .command("update-schema <name>")
    .description("Modify a collection schema")
    .option("--add <json>", "Fields to add as JSON")
    .option("--remove <fields>", "Comma-separated field names to remove")
    .option("--update <json>", "Field definitions to update as JSON")
    .option(
      "--validations <json>",
      "Replace collection expression rules as JSON",
    )
    .action(
      withErrorHandling(
        async (
          name: string,
          commandOptions: {
            add?: string;
            remove?: string;
            update?: string;
            validations?: string;
          },
          command: Command,
        ) => {
          const body: Record<string, unknown> = {};
          if (commandOptions.validations !== undefined)
            body.validations = parseJson<CollectionValidation[]>(
              commandOptions.validations,
              "--validations",
            );
          if (commandOptions.add) {
            body.add_fields = parseJson<Schema>(commandOptions.add, "--add");
          }
          if (commandOptions.remove) {
            body.remove_fields = commandOptions.remove
              .split(",")
              .map((field) => field.trim())
              .filter(Boolean);
          }
          if (commandOptions.update) {
            body.update_fields = parseJson(commandOptions.update, "--update");
          }
          if (Object.keys(body).length === 0) {
            throw new CliError(
              "Provide at least one of --add, --remove, --update, or --validations.",
            );
          }

          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getDataApi(client).v1.orgs[
            ":orgId"
          ].collections[":name"].schema.$patch({
            param: { orgId, name },
            json: body,
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            policies?: Array<{
              resource: string;
              action: string;
              cond: string;
              msg: string;
            }>;
            name: string;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            `Updated schema for '${result.name}'`,
          );
        },
      ),
    );

  collections
    .command("delete <name>")
    .alias("rm")
    .description("Delete a collection and all of its records")
    .option("--confirm", "Confirm deletion (required)")
    .action(
      withErrorHandling(
        async (
          name: string,
          commandOptions: { confirm?: boolean },
          command: Command,
        ) => {
          if (!commandOptions.confirm) {
            throw new CliError(
              "Pass --confirm to delete this collection and all of its records.",
            );
          }
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getDataApi(client).v1.orgs[
            ":orgId"
          ].collections[":name"].$delete({
            param: { orgId, name },
            query: { confirm: "true" },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            policies?: Array<{
              resource: string;
              action: string;
              cond: string;
              msg: string;
            }>;
            message: string;
          }>(response);
          dependencies.writeOutput(result, options, result.message);
        },
      ),
    );
}

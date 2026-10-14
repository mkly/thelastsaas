import {
  recordHistoryQuerySchema,
  type RecordHistoryResult,
  type AggregateRequest,
  type Where,
} from "@lastsaas/shared";
import type { Command } from "commander";

import { parseJson, withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import type { GlobalOptions } from "../index";
import {
  defaultDataCommandDependencies,
  getDataApi,
  type DataCommandDependencies,
} from "./data-client";

interface QueryOptions {
  expand?: string;
  where?: string;
  orderBy?: string;
  limit: string;
  offset: string;
  occursBetween?: string;
  from?: string;
  to?: string;
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function integerOption(value: string, label: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new CliError(`${label} must be an integer of at least ${minimum}.`);
  }
  return parsed;
}

function queryWhere(options: QueryOptions): Where | undefined {
  const where = options.where
    ? parseJson<Where>(options.where, "--where")
    : undefined;
  const recurrenceValues = [options.occursBetween, options.from, options.to];
  const hasRecurrenceOption = recurrenceValues.some(
    (value) => value !== undefined,
  );
  if (!hasRecurrenceOption) return where;
  if (recurrenceValues.some((value) => value === undefined)) {
    throw new CliError(
      "--occurs-between, --from, and --to must be provided together.",
    );
  }

  const occurrenceClause = {
    [options.occursBetween!]: {
      occurs_between: [options.from!, options.to!],
    },
  } as Where;
  return where ? { and: [where, occurrenceClause] } : occurrenceClause;
}

export function registerRecords(
  program: Command,
  dependencies: DataCommandDependencies = defaultDataCommandDependencies,
): void {
  const records = program
    .command("records")
    .alias("r")
    .description("Manage records in a collection");

  records
    .command("related <collection> <id>")
    .description("Find records that reference this record")
    .requiredOption("--source <collection>", "Source collection")
    .requiredOption(
      "--field <field>",
      "Reference field on the source collection",
    )
    .option("--where <json>", "Additional source filters")
    .option("--order-by <field>", "Sort by field, prefix with - for descending")
    .option("--expand <paths>", "Comma-separated reference paths")
    .option("--limit <n>", "Maximum records", "50")
    .option("--offset <n>", "Skip records", "0")
    .action(
      withErrorHandling(
        async (
          collection: string,
          id: string,
          opts: {
            source: string;
            field: string;
            where?: string;
            orderBy?: string;
            expand?: string;
            limit: string;
            offset: string;
          },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await client.v1.orgs[":orgId"].collections[
            ":name"
          ].records[":id"].related.$post({
            param: { orgId, name: collection, id },
            json: {
              source_collection: opts.source,
              field: opts.field,
              ...(opts.where
                ? { where: parseJson<Where>(opts.where, "--where") }
                : {}),
              ...(opts.expand ? { expand: opts.expand.split(",") } : {}),
              ...(opts.orderBy ? { order_by: opts.orderBy } : {}),
              limit: integerOption(opts.limit, "--limit", 1),
              offset: integerOption(opts.offset, "--offset", 0),
            },
          });
          dependencies.writeOutput(
            await dependencies.handleResponse(response),
            options,
          );
        },
      ),
    );

  records
    .command("history <collection> [id]")
    .description(
      "Read the last 30 days of permitted record changes, including deletions",
    )
    .option("--since <timestamp>", "Inclusive time range start")
    .option("--until <timestamp>", "Exclusive time range end")
    .option("--change-set-id <id>", "Filter changes from one atomic operation")
    .option("--limit <n>", "Maximum visible changes", "50")
    .option("--cursor <cursor>", "Continue with next_cursor")
    .action(
      withErrorHandling(
        async (
          collection: string,
          id: string | undefined,
          opts: {
            since?: string;
            until?: string;
            changeSetId?: string;
            limit: string;
            cursor?: string;
          },
          command: Command,
        ) => {
          const parsed = recordHistoryQuerySchema.safeParse({
            record_id: id,
            since: opts.since,
            until: opts.until,
            change_set_id: opts.changeSetId,
            limit: Number(opts.limit),
            cursor: opts.cursor,
          });
          if (!parsed.success)
            throw new CliError(
              parsed.error.issues.map((issue) => issue.message).join("; "),
            );
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const query = Object.fromEntries(
            Object.entries(parsed.data)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [key, String(value)]),
          );
          const response = await client.v1.orgs[":orgId"].collections[
            ":name"
          ].history.$get({
            param: { orgId, name: collection },
            query,
          });
          const result =
            await dependencies.handleResponse<RecordHistoryResult>(response);
          dependencies.writeOutput(result, options);
        },
      ),
    );

  records
    .command("insert <collection>")
    .alias("add")
    .description("Insert a record")
    .requiredOption("-d, --data <json>", "Record data as JSON")
    .action(
      withErrorHandling(
        async (
          collection: string,
          commandOptions: { data: string },
          command: Command,
        ) => {
          const data = parseJson<Record<string, unknown>>(
            commandOptions.data,
            "--data",
          );
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getDataApi(client).v1.orgs[
            ":orgId"
          ].collections[":name"].records.$post({
            param: { orgId, name: collection },
            json: { data },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(result, options);
        },
      ),
    );

  records
    .command("get <collection> <id>")
    .description("Get a record by ID")
    .option("--expand <paths>", "Comma-separated reference paths")
    .action(
      withErrorHandling(
        async (
          collection: string,
          id: string,
          commandOptions: { expand?: string },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await client.v1.orgs[":orgId"].collections[
            ":name"
          ].records[":id"].$get({
            param: { orgId, name: collection, id },
            query: commandOptions.expand
              ? { expand: commandOptions.expand }
              : {},
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(result, options);
        },
      ),
    );

  records
    .command("update <collection> <id>")
    .description("Update a record")
    .requiredOption("-d, --data <json>", "Fields to update as JSON")
    .action(
      withErrorHandling(
        async (
          collection: string,
          id: string,
          commandOptions: { data: string },
          command: Command,
        ) => {
          const data = parseJson<Record<string, unknown>>(
            commandOptions.data,
            "--data",
          );
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getDataApi(client).v1.orgs[
            ":orgId"
          ].collections[":name"].records[":id"].$patch({
            param: { orgId, name: collection, id },
            json: { data },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(result, options);
        },
      ),
    );

  records
    .command("delete <collection> <id>")
    .alias("rm")
    .description("Delete a record")
    .action(
      withErrorHandling(
        async (
          collection: string,
          id: string,
          _commandOptions,
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getDataApi(client).v1.orgs[
            ":orgId"
          ].collections[":name"].records[":id"].$delete({
            param: { orgId, name: collection, id },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            message: string;
          }>(response);
          dependencies.writeOutput(result, options, result.message);
        },
      ),
    );

  records
    .command("query <collection>")
    .alias("q")
    .description("Query records with filters")
    .option("-w, --where <json>", "Filter conditions as JSON")
    .option("--expand <paths>", "Comma-separated reference paths")
    .option("-o, --order-by <field>", "Sort field (prefix with - for DESC)")
    .option("-l, --limit <n>", "Maximum records to return", "50")
    .option("--offset <n>", "Skip the first N records", "0")
    .option(
      "--occurs-between <field>",
      "Recurrence field to expand in a time window",
    )
    .option("--from <datetime>", "Recurrence window start (inclusive)")
    .option("--to <datetime>", "Recurrence window end (exclusive)")
    .action(
      withErrorHandling(
        async (
          collection: string,
          commandOptions: QueryOptions,
          command: Command,
        ) => {
          const body: Record<string, unknown> = {
            limit: integerOption(commandOptions.limit, "--limit", 1),
            offset: integerOption(commandOptions.offset, "--offset", 0),
          };
          const where = queryWhere(commandOptions);
          if (where) body.where = where;
          if (commandOptions.expand)
            body.expand = commandOptions.expand.split(",");
          if (commandOptions.orderBy) body.order_by = commandOptions.orderBy;

          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getDataApi(client).v1.orgs[
            ":orgId"
          ].collections[":name"].records.query.$post({
            param: { orgId, name: collection },
            json: body,
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            records: Record<string, unknown>[];
            total?: number;
          }>(response);
          const human =
            result.records.length === 0
              ? "No records found."
              : result.records
                  .map((record) => JSON.stringify(record))
                  .join("\n");
          dependencies.writeOutput(result, options, human);
          if (!options.json && result.total !== undefined) {
            console.error(
              `(${result.records.length} of ${result.total} records)`,
            );
          }
        },
      ),
    );

  records
    .command("count <collection>")
    .description("Count records matching a filter")
    .option("-w, --where <json>", "Filter conditions as JSON")
    .action(
      withErrorHandling(
        async (
          collection: string,
          commandOptions: { where?: string },
          command: Command,
        ) => {
          const body: Record<string, unknown> = {};
          if (commandOptions.where) {
            body.where = parseJson<Where>(commandOptions.where, "--where");
          }
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getDataApi(client).v1.orgs[
            ":orgId"
          ].collections[":name"].records.count.$post({
            param: { orgId, name: collection },
            json: body,
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            count: number;
          }>(response);
          dependencies.writeOutput(result, options, String(result.count));
        },
      ),
    );

  records
    .command("batch <collection>")
    .description("Insert multiple records")
    .requiredOption("-d, --data <json>", "Array of record objects as JSON")
    .action(
      withErrorHandling(
        async (
          collection: string,
          commandOptions: { data: string },
          command: Command,
        ) => {
          const batch = parseJson<unknown>(commandOptions.data, "--data");
          if (!Array.isArray(batch)) {
            throw new CliError("--data must be a JSON array.");
          }
          const records = batch as Record<string, unknown>[];
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getDataApi(client).v1.orgs[
            ":orgId"
          ].collections[":name"].records.batch.$post({
            param: { orgId, name: collection },
            json: { records },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            inserted: number;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            `Inserted ${result.inserted} records`,
          );
        },
      ),
    );

  records
    .command("aggregate <collection>")
    .alias("agg")
    .description("Aggregate records with metrics and optional grouping")
    .option("-w, --where <json>", "Filter conditions as JSON (Where DSL)")
    .option("-g, --group-by <fields>", "Comma-separated grouping fields")
    .requiredOption("-m, --metrics <json>", "Metrics as a JSON array")
    .option("--having <json>", "Filter on metric aliases as JSON")
    .option("-o, --order-by <field>", "Sort by alias (prefix with - for DESC)")
    .option("-l, --limit <n>", "Maximum rows", "100")
    .option("--offset <n>", "Skip the first N rows", "0")
    .action(
      withErrorHandling(
        async (
          collection: string,
          commandOptions: {
            where?: string;
            groupBy?: string;
            metrics: string;
            having?: string;
            orderBy?: string;
            limit: string;
            offset: string;
          },
          command: Command,
        ) => {
          const body: AggregateRequest = {
            metrics: parseJson(commandOptions.metrics, "--metrics"),
            limit: integerOption(commandOptions.limit, "--limit", 1),
            offset: integerOption(commandOptions.offset, "--offset", 0),
          };
          if (commandOptions.where) {
            body.where = parseJson(commandOptions.where, "--where");
          }
          if (commandOptions.groupBy) {
            body.group_by = commandOptions.groupBy
              .split(",")
              .map((field) => field.trim())
              .filter(Boolean);
          }
          if (commandOptions.having) {
            body.having = parseJson(commandOptions.having, "--having");
          }
          if (commandOptions.orderBy) body.order_by = commandOptions.orderBy;

          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getDataApi(client).v1.orgs[
            ":orgId"
          ].collections[":name"].records.aggregate.$post({
            param: { orgId, name: collection },
            json: body as unknown as Record<string, unknown>,
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            rows: Record<string, unknown>[];
          }>(response);
          const human =
            result.rows.length === 0
              ? "No results."
              : result.rows.map((row) => JSON.stringify(row)).join("\n");
          dependencies.writeOutput(result, options, human);
        },
      ),
    );
}

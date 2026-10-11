import {
  AUTOMATION_LIMITS,
  pageRequestSchema,
  resourceNameSchema,
  type SecretListResponse,
  type SecretMetadata,
  type SecretResponse,
  type SecretRevealResponse,
} from "@lastsaas/shared";
import type { Command } from "commander";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { CliError } from "../errors";
import { getGlobalOptions } from "../index";
import {
  defaultOperationsCommandDependencies,
  type OperationsCommandDependencies,
} from "./operations-client";
import { handleSecretResponse } from "./secret-response";

interface ValueOptions {
  file?: string;
  stdin?: boolean;
}

export interface SecretsCommandDependencies extends OperationsCommandDependencies {
  readValue(options: ValueOptions): Promise<string>;
  /** Write a revealed value verbatim, without an added trailing newline. */
  writeValue(value: string): void;
}

/** Preserve whitespace and reject oversized/invalid UTF-8 input without diagnostics. */
export async function readSecretStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > AUTOMATION_LIMITS.secretBytes) {
        throw new CliError("Secret exceeds 64 KiB of UTF-8.");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Could not read secret input.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new CliError("Secret input must be valid UTF-8.");
  }
}

export async function readSecretValue(options: ValueOptions): Promise<string> {
  if (options.stdin) {
    if (process.stdin.isTTY) {
      throw new CliError("Pipe secret input to --stdin or use --file.");
    }
    return readSecretStream(process.stdin);
  }
  return readSecretStream(createReadStream(options.file!));
}

const defaultDependencies: SecretsCommandDependencies = {
  ...defaultOperationsCommandDependencies,
  handleResponse: handleSecretResponse,
  readValue: readSecretValue,
  writeValue: (value) => {
    process.stdout.write(value);
  },
};

function validateName(name: string): void {
  if (!resourceNameSchema.safeParse(name).success) {
    throw new CliError(
      "Secret names must start with a letter and contain only letters, digits or underscores (maximum 64 characters).",
    );
  }
}

// Project metadata explicitly even if a server sends extra fields.
function metadata(secret: SecretMetadata): SecretMetadata {
  return {
    id: secret.id,
    organization_id: secret.organization_id,
    name: secret.name,
    key_version: secret.key_version,
    created_at: secret.created_at,
    updated_at: secret.updated_at,
  };
}

function details(secret: SecretMetadata): string {
  return [
    `${secret.name} (${secret.id})`,
    `  Encryption key version: ${secret.key_version}`,
    `  Created: ${secret.created_at}`,
    `  Updated: ${secret.updated_at}`,
  ].join("\n");
}

function withSecretErrors<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>,
) {
  return async (...args: Args): Promise<void> => {
    try {
      await action(...args);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        "Secret operation failed. Check the server connection and try again.",
      );
    }
  };
}

export function registerSecrets(
  program: Command,
  dependencies: SecretsCommandDependencies = defaultDependencies,
): void {
  const secrets = program
    .command("secrets")
    .description("Manage secret metadata and explicitly reveal values");
  secrets.addHelpText(
    "after",
    `
Metadata read permission on /secrets/<name> does not grant reveal.
Reveal requires read on /secrets/<name>/value. Create requires write on
/secrets; replace requires manage and delete requires delete on /secrets/<name>.
Values are encrypted with server-configured keys. key_version identifies an
encryption key version, not an API token or a secret value.
Use --file or piped --stdin for values; all whitespace is preserved.
`,
  );

  for (const operation of ["create", "replace"] as const) {
    secrets
      .command(`${operation} <name>`)
      .description(
        operation === "create"
          ? "Create a secret; return metadata only"
          : "Replace a secret value; return metadata only",
      )
      .option(
        "--file <path>",
        "Read the UTF-8 secret value from a file (maximum 64 KiB)",
      )
      .option(
        "--stdin",
        "Read the UTF-8 secret value from piped stdin (maximum 64 KiB)",
      )
      .action(
        withSecretErrors(
          async (
            name: string,
            valueOptions: ValueOptions,
            command: Command,
          ) => {
            validateName(name);
            if (
              Number(valueOptions.file !== undefined) +
                Number(!!valueOptions.stdin) !==
              1
            ) {
              throw new CliError("Supply exactly one of --file or --stdin.");
            }
            const options = getGlobalOptions(command);
            const { client, orgId } = dependencies.getOrgClient(options);
            const value = await dependencies.readValue(valueOptions);
            if (
              Buffer.byteLength(value, "utf8") > AUTOMATION_LIMITS.secretBytes
            ) {
              throw new CliError("Secret exceeds 64 KiB of UTF-8.");
            }
            const api = client.v1.orgs[":orgId"].secrets;
            const response =
              operation === "create"
                ? await api.$post({ param: { orgId }, json: { name, value } })
                : await api[":name"].$patch({
                    param: { orgId, name },
                    json: { value },
                  });
            const result =
              await dependencies.handleResponse<SecretResponse>(response);
            const secret = metadata(result.secret);
            dependencies.writeOutput(
              { status: "ok", secret },
              options,
              details(secret),
            );
          },
        ),
      );
  }

  secrets
    .command("list")
    .description("List secret metadata (never values)")
    .option("--limit <n>", "Maximum items (1..100)")
    .option("--cursor <cursor>", "Continue from next_cursor")
    .action(
      withSecretErrors(
        async (
          input: { limit?: string; cursor?: string },
          command: Command,
        ) => {
          const parsed = pageRequestSchema.safeParse({
            ...(input.limit === undefined
              ? {}
              : {
                  limit: /^\d+$/.test(input.limit) ? Number(input.limit) : NaN,
                }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          });
          if (!parsed.success)
            throw new CliError(
              "Use a limit from 1 to 100 and a nonempty cursor of at most 2048 characters.",
            );
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const result = await dependencies.handleResponse<SecretListResponse>(
            await client.v1.orgs[":orgId"].secrets.$get({
              param: { orgId },
              query: {
                limit: String(parsed.data.limit),
                ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
              },
            }),
          );
          const items = result.items.map(metadata);
          const human = [
            items.length ? items.map(details).join("\n\n") : "No secrets.",
            ...(result.next_cursor
              ? [`Next cursor: ${result.next_cursor}`]
              : []),
          ].join("\n");
          dependencies.writeOutput(
            { status: "ok", items, next_cursor: result.next_cursor },
            options,
            human,
          );
        },
      ),
    );

  secrets
    .command("show <name>")
    .description("Show secret metadata (never the value)")
    .action(
      withSecretErrors(async (name: string, _input, command: Command) => {
        validateName(name);
        const options = getGlobalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const result = await dependencies.handleResponse<SecretResponse>(
          await client.v1.orgs[":orgId"].secrets[":name"].$get({
            param: { orgId, name },
          }),
        );
        const secret = metadata(result.secret);
        dependencies.writeOutput(
          { status: "ok", secret },
          options,
          details(secret),
        );
      }),
    );

  secrets
    .command("delete <name>")
    .description("Delete a secret")
    .option("--confirm", "Confirm deletion (required)")
    .action(
      withSecretErrors(
        async (
          name: string,
          input: { confirm?: boolean },
          command: Command,
        ) => {
          validateName(name);
          if (!input.confirm)
            throw new CliError("Pass --confirm to delete this secret.");
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          await dependencies.handleResponse(
            await client.v1.orgs[":orgId"].secrets[":name"].$delete({
              param: { orgId, name },
            }),
          );
          dependencies.writeOutput(
            { status: "ok" },
            options,
            `Deleted secret '${name}'.`,
          );
        },
      ),
    );

  secrets
    .command("reveal <name>")
    .description(
      "Explicitly print a secret value (requires read on /secrets/<name>/value)",
    )
    .action(
      withSecretErrors(async (name: string, _input, command: Command) => {
        validateName(name);
        const options = getGlobalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const result = await dependencies.handleResponse<SecretRevealResponse>(
          await client.v1.orgs[":orgId"].secrets[":name"].reveal.$post({
            param: { orgId, name },
            json: {},
          }),
        );
        const secret = {
          id: result.secret.id,
          name: result.secret.name,
          value: result.secret.value,
        };
        if (options.json) {
          dependencies.writeOutput({ status: "ok", secret }, options);
        } else {
          dependencies.writeValue(secret.value);
        }
      }),
    );
}

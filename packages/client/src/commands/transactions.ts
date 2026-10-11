import {
  AUTOMATION_LIMITS,
  transactionRequestSchema,
  type TransactionResponse,
} from "@lastsaas/shared";
import type { Command } from "commander";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { parseJson, withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import { getGlobalOptions } from "../index";
import {
  defaultOperationsCommandDependencies,
  type OperationsCommandDependencies,
} from "./operations-client";

interface InputOptions {
  input?: string;
  stdin?: boolean;
}

export interface TransactionsCommandDependencies extends OperationsCommandDependencies {
  readInput(options: InputOptions): Promise<string>;
}

/** Bound raw bytes before decoding or parsing, including JSON whitespace. */
export async function readTransactionStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > AUTOMATION_LIMITS.transactionBytes) {
        throw new CliError("Transaction input exceeds 1 MiB of UTF-8 JSON.");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Could not read transaction input.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new CliError("Transaction input must be valid UTF-8.");
  }
}

export async function readTransactionInput(
  options: InputOptions,
): Promise<string> {
  if (Number(options.input !== undefined) + Number(!!options.stdin) !== 1) {
    throw new CliError("Supply exactly one of --input or --stdin.");
  }
  if (options.stdin) {
    if (process.stdin.isTTY) {
      throw new CliError("Pipe transaction JSON to --stdin or use --input.");
    }
    return readTransactionStream(process.stdin);
  }
  return readTransactionStream(createReadStream(options.input!));
}

const defaultDependencies: TransactionsCommandDependencies = {
  ...defaultOperationsCommandDependencies,
  readInput: readTransactionInput,
};

export function registerTransactions(
  program: Command,
  dependencies: TransactionsCommandDependencies = defaultDependencies,
): void {
  const transactions = program
    .command("transactions")
    .description("Submit bounded atomic record and queue operations");

  transactions
    .command("execute")
    .description("Execute one transaction and return results in input order")
    .option("--input <file>", "Read a transaction JSON request from a file")
    .option("--stdin", "Read a transaction JSON request from piped stdin")
    .option("--idempotency-key <key>", "Reuse a key for the same request")
    .addHelpText(
      "after",
      `
Supply exactly one of --input or --stdin (maximum 1 MiB of UTF-8 JSON).
Input is {"operations":[...],"idempotency_key":"optional key"}, with 1..25
record.create, record.update, record.delete or queue.enqueue operations.
IDs and payloads are literal; results cannot be referenced by later operations.
All operations commit together or roll back together. No automatic retries.
Idempotency keys are scoped to organization and principal, retained for 7 days;
reusing a key with different operations fails. --idempotency-key may supply a
key absent from input or match the input key, but cannot replace a different key.
`,
    )
    .action(
      withErrorHandling(
        async (
          input: InputOptions & { idempotencyKey?: string },
          command: Command,
        ) => {
          if (Number(input.input !== undefined) + Number(!!input.stdin) !== 1) {
            throw new CliError("Supply exactly one of --input or --stdin.");
          }
          const text = await dependencies.readInput(input);
          if (
            Buffer.byteLength(text, "utf8") > AUTOMATION_LIMITS.transactionBytes
          ) {
            throw new CliError(
              "Transaction input exceeds 1 MiB of UTF-8 JSON.",
            );
          }
          let value = parseJson(text, "Transaction input");
          if (input.idempotencyKey !== undefined) {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              throw new CliError("Transaction input must be a request object.");
            }
            const request = value as Record<string, unknown>;
            if (
              request.idempotency_key !== undefined &&
              request.idempotency_key !== input.idempotencyKey
            ) {
              throw new CliError(
                "--idempotency-key conflicts with the input key.",
              );
            }
            value = { ...request, idempotency_key: input.idempotencyKey };
          }
          const parsed = transactionRequestSchema.safeParse(value);
          if (!parsed.success) {
            throw new CliError(
              "Invalid transaction request. Use 1..25 supported literal operations, an optional nonempty idempotency key of at most 256 characters, and at most 1 MiB of UTF-8 JSON.",
            );
          }
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          let response: Response;
          try {
            response = await client.v1.orgs[":orgId"].transactions.$post({
              param: { orgId },
              json: parsed.data,
            });
          } catch {
            // Bun network errors do not always contain "fetch" or "network".
            throw new CliError("Could not connect to The Last SaaS server.");
          }
          const result =
            await dependencies.handleResponse<TransactionResponse>(response);
          dependencies.writeOutput(result, options);
        },
      ),
    );
}

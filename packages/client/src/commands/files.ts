import type { File as FileRecord } from "@lastsaas/shared";
import type { Command } from "commander";
import { once } from "node:events";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import type { GlobalOptions } from "../index";
import {
  defaultOperationsCommandDependencies,
  getOperationsApi,
  type OperationsCommandDependencies,
} from "./operations-client";

export interface FilesCommandDependencies extends OperationsCommandDependencies {
  openFile(path: string): Blob;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  cwd(): string;
  streamResponse(response: Response, outputPath?: string): Promise<void>;
}

async function writeResponseStream(
  response: Response,
  outputPath?: string,
): Promise<void> {
  if (!response.body) throw new CliError("The server returned no file data.");

  if (outputPath) {
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(outputPath),
    );
    return;
  }

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!process.stdout.write(value)) await once(process.stdout, "drain");
  }
}

const defaultDependencies: FilesCommandDependencies = {
  ...defaultOperationsCommandDependencies,
  openFile: (path) => Bun.file(path),
  exists: existsSync,
  isDirectory: (path) => statSync(path).isDirectory(),
  cwd: () => process.cwd(),
  streamResponse: writeResponseStream,
};

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function formatBytes(sizeBytes: number | null): string {
  if (sizeBytes === null) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let size = sizeBytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rendered =
    unitIndex === 0 ? String(size) : size.toFixed(size >= 10 ? 0 : 1);
  return `${rendered}${units[unitIndex]}`;
}

function fileListOutput(files: FileRecord[]): string {
  if (files.length === 0) return "No files.";
  return files
    .map(
      (file) =>
        `  ${file.id.padEnd(24)} ${formatBytes(file.size_bytes).padStart(8)}  ${file.path}`,
    )
    .join("\n");
}

function fileDetails(file: FileRecord): string {
  return [
    `${file.filename} (${file.id})`,
    `  Path:        ${file.path}`,
    `  Size:        ${formatBytes(file.size_bytes)}`,
    `  MIME:        ${file.mime_type ?? "-"}`,
    `  Uploaded by: ${file.uploaded_by}`,
    `  Created:     ${file.created_at}`,
  ].join("\n");
}

function responseFilename(response: Response, id: string): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return /filename="([^"]+)"/i.exec(disposition)?.[1] ?? id;
}

function downloadPath(
  dependencies: FilesCommandDependencies,
  filename: string,
  requested?: string,
): string {
  if (!requested) return join(dependencies.cwd(), filename);
  const resolved = resolve(requested);
  return dependencies.exists(resolved) && dependencies.isDirectory(resolved)
    ? join(resolved, filename)
    : resolved;
}

export function registerFiles(
  program: Command,
  dependencies: FilesCommandDependencies = defaultDependencies,
): void {
  const files = program
    .command("files")
    .alias("fi")
    .description("Manage files");

  files
    .command("list")
    .alias("ls")
    .description("List files, optionally below a path prefix")
    .option("-p, --prefix <path>", "Only list paths with this prefix")
    .action(
      withErrorHandling(
        async (commandOptions: { prefix?: string }, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].files.$get({
            param: { orgId },
            query: commandOptions.prefix
              ? { prefix: commandOptions.prefix }
              : {},
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            files: FileRecord[];
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            fileListOutput(result.files),
          );
        },
      ),
    );

  files
    .command("upload <local-path>")
    .description("Stream a local file to the server")
    .option(
      "-p, --path <remote-path>",
      "Remote slash-separated path (defaults to the local filename)",
    )
    .action(
      withErrorHandling(
        async (
          localPath: string,
          commandOptions: { path?: string },
          command: Command,
        ) => {
          if (!dependencies.exists(localPath)) {
            throw new CliError(`File '${localPath}' does not exist.`);
          }
          if (dependencies.isDirectory(localPath)) {
            throw new CliError(`'${localPath}' is a directory, not a file.`);
          }

          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const remotePath = commandOptions.path ?? basename(localPath);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].files.$post({
            param: { orgId },
            form: {
              file: dependencies.openFile(localPath),
              path: remotePath,
            },
          });
          const result = await dependencies.handleResponse<
            FileRecord & { status: "ok" }
          >(response);
          dependencies.writeOutput(
            result,
            options,
            `Uploaded '${result.path}' (${result.id})`,
          );
        },
      ),
    );

  files
    .command("get <id>")
    .alias("inspect")
    .description("Show file metadata")
    .action(
      withErrorHandling(
        async (id: string, _commandOptions, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].files[":id"].$get({ param: { orgId, id } });
          const result = await dependencies.handleResponse<
            FileRecord & { status: "ok" }
          >(response);
          dependencies.writeOutput(result, options, fileDetails(result));
        },
      ),
    );

  files
    .command("download <id>")
    .alias("dl")
    .description("Stream file content from the server")
    .option("-o, --output <path>", "Write to this file or directory")
    .option("--stdout", "Write bytes to stdout")
    .option("--force", "Overwrite an existing output file")
    .action(
      withErrorHandling(
        async (
          id: string,
          commandOptions: {
            output?: string;
            stdout?: boolean;
            force?: boolean;
          },
          command: Command,
        ) => {
          if (commandOptions.stdout && commandOptions.output) {
            throw new CliError("Use either --stdout or --output, not both.");
          }
          const options = globalOptions(command);
          if (options.json) {
            throw new CliError("--json cannot be used with file downloads.");
          }

          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].files[":id"].content.$get({ param: { orgId, id } });
          if (!response.ok) {
            await dependencies.handleResponse(response);
          }

          if (commandOptions.stdout) {
            await dependencies.streamResponse(response);
            return;
          }

          const filename = responseFilename(response, id);
          const outputPath = downloadPath(
            dependencies,
            filename,
            commandOptions.output,
          );
          if (!commandOptions.force && dependencies.exists(outputPath)) {
            throw new CliError(
              `Refusing to overwrite '${outputPath}'. Pass --force to replace it.`,
            );
          }
          await dependencies.streamResponse(response, outputPath);
          dependencies.writeOutput(
            { status: "ok", id, filename, output: outputPath },
            options,
            `Downloaded '${filename}' to ${outputPath}`,
          );
        },
      ),
    );

  files
    .command("delete <id>")
    .alias("rm")
    .description("Delete a file")
    .option("--confirm", "Confirm deletion (required)")
    .action(
      withErrorHandling(
        async (
          id: string,
          commandOptions: { confirm?: boolean },
          command: Command,
        ) => {
          if (!commandOptions.confirm) {
            throw new CliError("Pass --confirm to delete this file.");
          }
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].files[":id"].$delete({ param: { orgId, id } });
          const result = await dependencies.handleResponse<{
            status: "ok";
            message: string;
          }>(response);
          dependencies.writeOutput(result, options, result.message);
        },
      ),
    );
}

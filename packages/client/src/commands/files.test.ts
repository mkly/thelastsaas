import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import { registerFiles, type FilesCommandDependencies } from "./files";

function testProgram(): Command {
  return new Command().exitOverride().option("--org <org-id>").option("--json");
}

function dependencies(client: Record<string, unknown>) {
  const outputs: Array<{ value: unknown; human?: string }> = [];
  const streams: Array<{ response: Response; outputPath?: string }> = [];
  const deps: FilesCommandDependencies = {
    getOrgClient: () => ({
      client: client as never,
      config: {} as never,
      orgId: "org_123",
    }),
    handleResponse: async (response) => response as never,
    writeOutput: (value, _options, human) => outputs.push({ value, human }),
    openFile: () => new Blob(["hello"], { type: "text/plain" }),
    exists: (path) => path === "source.txt",
    isDirectory: () => false,
    cwd: () => "/tmp",
    streamResponse: async (response, outputPath) => {
      streams.push({ response, outputPath });
    },
  };
  return { deps, outputs, streams };
}

describe("files commands", () => {
  test("forwards prefix listing with organization scope", async () => {
    const calls: unknown[] = [];
    const client = {
      v1: {
        orgs: {
          ":orgId": {
            files: {
              $get: async (input: unknown) => {
                calls.push(input);
                return {
                  status: "ok",
                  files: [
                    {
                      id: "file_1",
                      path: "reports/today.csv",
                      filename: "today.csv",
                      mime_type: "text/csv",
                      size_bytes: 12,
                      collection_id: null,
                      record_id: null,
                      uploaded_by: "user_1",
                      created_at: "2026-08-18T00:00:00.000Z",
                    },
                  ],
                };
              },
            },
          },
        },
      },
    };
    const { deps, outputs } = dependencies(client);
    const program = testProgram();
    registerFiles(program, deps);

    await program.parseAsync(
      ["--org", "org_123", "files", "list", "--prefix", "reports/"],
      { from: "user" },
    );

    expect(calls).toEqual([
      { param: { orgId: "org_123" }, query: { prefix: "reports/" } },
    ]);
    expect(outputs[0]?.human).toContain("reports/today.csv");
  });

  test("uploads a Blob as multipart data without base64 buffering", async () => {
    const calls: Array<{
      param: { orgId: string };
      form: { file: Blob; path?: string };
    }> = [];
    const client = {
      v1: {
        orgs: {
          ":orgId": {
            files: {
              $post: async (input: (typeof calls)[number]) => {
                calls.push(input);
                return {
                  status: "ok",
                  id: "file_2",
                  path: "docs/greeting.txt",
                };
              },
            },
          },
        },
      },
    };
    const { deps, outputs } = dependencies(client);
    const program = testProgram();
    registerFiles(program, deps);

    await program.parseAsync(
      ["files", "upload", "source.txt", "--path", "docs/greeting.txt"],
      { from: "user" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.param).toEqual({ orgId: "org_123" });
    expect(calls[0]?.form.path).toBe("docs/greeting.txt");
    expect(calls[0]?.form.file).toBeInstanceOf(Blob);
    expect(await calls[0]?.form.file.text()).toBe("hello");
    expect(outputs[0]?.human).toBe("Uploaded 'docs/greeting.txt' (file_2)");
  });

  test("streams downloads to the Content-Disposition filename", async () => {
    const response = new Response("hello", {
      headers: {
        "content-disposition": 'attachment; filename="notes.txt"',
      },
    });
    const client = {
      v1: {
        orgs: {
          ":orgId": {
            files: {
              ":id": {
                content: { $get: async () => response },
              },
            },
          },
        },
      },
    };
    const { deps, outputs, streams } = dependencies(client);
    const program = testProgram();
    registerFiles(program, deps);

    await program.parseAsync(["files", "download", "file_3"], {
      from: "user",
    });

    expect(streams).toEqual([{ response, outputPath: "/tmp/notes.txt" }]);
    expect(outputs[0]?.human).toBe("Downloaded 'notes.txt' to /tmp/notes.txt");
  });
});

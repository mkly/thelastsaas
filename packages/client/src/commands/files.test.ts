import { describe, expect, test, spyOn } from "bun:test";
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

  test("uploads raw bytes to the prepared URL then completes with organization auth", async () => {
    const calls: unknown[] = [];
    const client = {
      v1: {
        orgs: {
          ":orgId": {
            files: {
              uploads: {
                $post: async (input: unknown) => {
                  calls.push(input);
                  return {
                    upload_id: "upload_1",
                    upload_url: "https://storage.example/upload",
                    headers: { "Content-Type": "text/plain" },
                  };
                },
                ":id": {
                  complete: {
                    $post: async (input: unknown) => {
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
          },
        },
      },
    };
    const { deps, outputs } = dependencies(client);
    const program = testProgram();
    registerFiles(program, deps);
    const transfer = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (url: unknown, options?: RequestInit) => {
          expect(url).toBe("https://storage.example/upload");
          expect(options?.method).toBe("PUT");
          expect(options?.headers).toEqual({ "Content-Type": "text/plain" });
          expect(options?.body).toBeInstanceOf(Blob);
          expect(await (options!.body as Blob).text()).toBe("hello");
          return new Response(null, { status: 200 });
        },
        { preconnect: fetch.preconnect },
      ),
    );
    try {
      await program.parseAsync(
        ["files", "upload", "source.txt", "--path", "docs/greeting.txt"],
        { from: "user" },
      );
    } finally {
      transfer.mockRestore();
    }
    expect(calls).toEqual([
      {
        param: { orgId: "org_123" },
        json: {
          filename: "source.txt",
          path: "docs/greeting.txt",
          size_bytes: 5,
          mime_type: "text/plain;charset=utf-8",
        },
      },
      { param: { orgId: "org_123", id: "upload_1" } },
    ]);
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

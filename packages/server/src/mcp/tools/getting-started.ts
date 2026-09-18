import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const guide = `# Welcome to Last SaaS

Last SaaS stores lists, notes, and other data. You can ask your assistant to
add things, find them, or update them.

Start by creating your first reading list.

## The basics

- A **collection** is a group of records, like a reading list.
- A **record** is one item, like a book.
- A **field** is a detail, like the book's title or author.
- An **organization** is the space you're connected to. It can be personal or
  shared. Your permissions determine what you can see and change.

## Make a reading list

1. Ask "Create a reading list with a title and an author for each book."
2. Ask "Add The Hobbit by J. R. R. Tolkien to my reading list."
3. Ask "What's on my reading list?"

You can also ask to find a book or change a detail.

Opening this guide doesn't change any data. Trying the steps above saves a
list and a book. If you don't have permission for a step, your assistant will
explain what's available.

For the assistant: assume this is the person's first time using Last SaaS.
Keep the introduction short and follow the person's lead.
Use plain language. Avoid sales pitches, em dashes, and unnecessary reassurance.
Only create or change data when asked, not just because this guide was opened.
`;

export function registerGettingStarted(server: McpServer): void {
  server.registerTool(
    "getting_started",
    {
      description:
        "Read the basics of Last SaaS and an optional reading list example. Use when someone asks what Last SaaS does or wants help getting started.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text", text: guide }] }),
  );
}

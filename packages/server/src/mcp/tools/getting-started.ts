import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const guide = `# Welcome to Last SaaS

Last SaaS is a place to keep things you want to remember or organize, with help
from your assistant. You could keep a reading list, collect recipes, or share
notes for a community garden. A small list is a fine place to begin.

You can use everyday words. You don't need to learn tool names or write code.
Try asking: "Help me keep a list of books I'd like to read."

## A few words you might see

- A **collection** holds things of the same kind, like a reading list.
- A **record** is one thing in that collection, like a book.
- A **field** is a detail about it, like its title or author.
- An **organization** is the space you're connected to. It can be for you or
  shared with other people. What you can see and change depends on your access.

## Have a look around

Ask "What lists are already here?" Your assistant can use collections_list to
show the collections you have access to, then collections_describe to explain
one that interests you. If the space is empty, that's okay too.

## Try a little reading list

When you'd like to make something, ask "Create a reading list with a title and
an author for each book." Here's how your assistant can help:

1. Check collections_list for an existing reading list. If there is one, use
   collections_describe to check its fields before adding anything.
2. For a new list, call collections_create with:
   {"name":"reading_list","description":"Books I'd like to read","schema":{"title":"string","author":"string"}}
   If that name is already used for something else, choose another name together.
3. Ask which book you'd like to add. For example, "Add The Hobbit by J. R. R.
   Tolkien" becomes a records_insert call with:
   {"collection":"reading_list","data":{"title":"The Hobbit","author":"J. R. R. Tolkien"}}
4. Ask "What's on my reading list?" The assistant can call records_query with:
   {"collection":"reading_list","limit":20}

Reading this guide doesn't create or change anything. The creation and addition
steps save real data when you choose to try them. If your access doesn't allow a
step, your assistant can explain that and help you explore what's available.

## Where to go from here

You can ask your assistant to find an entry, change a detail, or help you make
another collection. Last SaaS also has tools for files, notifications, and
sharing access when those would be useful.

For the assistant: introduce the basics briefly, then follow the person's
interests one step at a time. Use ordinary language and the examples as a guide;
don't run the writing steps just because this tutorial was requested. There's
no need to cover every feature at once.
`;

export function registerGettingStarted(server: McpServer): void {
  server.registerTool(
    "getting_started",
    {
      description:
        "Read a friendly introduction to Last SaaS and a small, optional reading-list tutorial. Use when someone asks what Last SaaS does or wants help getting started.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text", text: guide }] }),
  );
}

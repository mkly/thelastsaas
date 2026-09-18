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

## Set a reading reminder

Once you've made your list, you can set up a notification. Ask "Remind me to
read tomorrow at 7 pm." Your assistant will help you choose where to receive it.

You can also ask for a recurring reminder, like "Remind me to read every
Sunday at 7 pm."

## Invite someone or set up an agent

If you'd like someone to join you, ask "Help me invite someone to my
organization." Your assistant will ask for their email address and help you
choose their access.

If you have an agent you'd like to connect, ask "Help me set up a service
account for my agent." A service account gives the agent its own identity
and access. Your assistant will help you choose what it can do and provide
a link to claim its access token.

Opening this guide doesn't change any data. Your assistant will carry out
the steps you ask for. If you don't have permission for a step, it will
explain what's available.

For the assistant: assume this is the person's first time using Last SaaS.
Keep the introduction short and follow the person's lead.
Use plain language. Avoid sales pitches, em dashes, and unnecessary reassurance.
Start with the reading list. After it's created, offer to set up a reading
reminder. After the reminder is set up, mention inviting someone or connecting
an agent as optional next steps. Introduce one step at a time and let the
person skip or stop. Ask for missing details before carrying out a step.
Only create or change data when asked, not just because this guide was opened.
`;

export function registerGettingStarted(server: McpServer): void {
  server.registerTool(
    "getting_started",
    {
      description:
        "Read the basics of Last SaaS with a reading list example and optional steps for reminders, invitations, and agent service accounts. Use when someone asks what Last SaaS does or wants help getting started.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text", text: guide }] }),
  );
}

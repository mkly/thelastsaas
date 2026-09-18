/** One tutorial, with only the connection-specific setup instructions varying. */
const organizationInstructions = {
  mcp: `First call organizations_list to check the active organization. A sole
organization is selected automatically. If none is selected, help the person
choose one with organizations_select, or ask for a name and permission to create
one with organizations_create. Use the connected MCP tools for the tutorial steps.`,
  cli: `First read saas skills print for command usage. Use the local saas CLI for
this tutorial. Check authentication and the active organization with saas whoami,
then list organizations with saas orgs list. If sign-in is needed, guide the person
through saas login, using --server for their server when needed. Preserve their
configured server and any explicit --org selection.
If no organization is selected, use saas orgs use <org-id>; choose the sole
organization when there is only one, or ask which to use when there are several.
If there are none, ask for a name and permission to run saas orgs create <name>,
which also selects the new organization. Use --json when reading command results.`,
} as const;

export function getGettingStartedGuide(
  interfaceType: keyof typeof organizationInstructions,
): string {
  return `# Welcome to Last SaaS

Last SaaS stores lists, notes, and other data. You can ask your assistant to
add things, find them, or update them.

Start by choosing a space for your data, then create your first reading list.

## The basics

- A **collection** is a group of records, like a reading list.
- A **record** is one item, like a book.
- A **field** is a detail, like the book's title or author.
- An **organization** is the space you're connected to. It can be personal or
  shared. Your permissions determine what you can see and change.

## Choose your organization

Your assistant can check your organizations and active selection. If you have none, ask
"Create an organization for me" and choose a name. If you have several, choose
which to use. You can switch organizations later by asking your assistant.

## Make a reading list

1. Ask "Create a reading list with a title and an author for each book."
2. Ask "Add Infinite Jest by David Foster Wallace to my reading list."
3. Ask "What's on my reading list?"

You can also ask to find a book or change a detail.

## Add a file

Ask "Help me upload a file with my reading notes." Your assistant will help you
choose a file and upload it to your organization.

Then ask "Show me my files" to find it again.

## Set a reading reminder

Once you've made your list, you can set up a notification. Ask "Remind me to
read tomorrow at 7 pm." Your assistant will help you choose where to receive it.

You can also ask for a recurring reminder, like "Remind me to read every
Sunday at 7 pm."

## Invite someone or set up an agent

If you'd like someone to join you, ask "Help me invite someone to my
organization." Your assistant will ask for their email address and help you
choose their access. For example, ask "Invite someone to view my Reading List."
Their access is applied automatically when they accept.

If you have an agent you'd like to connect, ask "Help me set up a service
account for my agent." A service account gives the agent its own identity
and access. Your assistant will help you choose what it can do and provide
a link to claim its access token.

## View the audit log

Ask "Show me the recent activity in my organization's audit log." You can see
who made changes and when, including the reading list and file you added.

Opening this guide doesn't change any data. Your assistant will carry out
the steps you ask for. If you don't have permission for a step, it will
explain what's available.

For the assistant: assume this is the person's first time using Last SaaS.
Keep the introduction short and follow the person's lead.
Use plain language. Avoid sales pitches, em dashes, and unnecessary reassurance.
When inviting someone with specific access, include the requested permissions in
the invitation. Do not wait for them to join before setting up their access.
${organizationInstructions[interfaceType]}

Then start with the reading list. After it's created, offer to upload a file
with reading notes, then set up a reading reminder. Mention inviting someone or
connecting an agent as optional next steps, and offer to view the audit log to
see the activity from the tutorial. Introduce one step at a time and let the
person skip or stop. Ask for missing details before carrying out a step.
Only create or change data when asked, not just because this guide was opened.
`;
}

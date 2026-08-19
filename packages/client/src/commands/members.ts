import type { Member } from "@lastsaas/shared";
import type { Command } from "commander";

import { withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import type { GlobalOptions } from "../index";
import {
  defaultAccessCommandDependencies,
  getAccessApi,
  type AccessCommandDependencies,
} from "./access-client";

type ManagedMemberRole = "admin" | "member";

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function managedRole(value: string): ManagedMemberRole {
  if (value === "admin" || value === "member") return value;
  throw new CliError("--role must be either admin or member.");
}

function memberListOutput(
  members: Member[],
  total: number,
  offset: number,
): string {
  if (members.length === 0) return "No members found.";

  const memberIdWidth = Math.max(
    9,
    ...members.map((member) => member.member_id.length),
  );
  const emailWidth = Math.max(
    5,
    ...members.map((member) => member.email.length),
  );
  const nameWidth = Math.max(
    4,
    ...members.map((member) => (member.name ?? "").length),
  );
  const roleWidth = Math.max(
    4,
    ...members.map((member) => member.member_role.length),
  );
  const header = [
    "member_id".padEnd(memberIdWidth),
    "email".padEnd(emailWidth),
    "name".padEnd(nameWidth),
    "role".padEnd(roleWidth),
    "casbin_roles",
  ].join("  ");
  const lines = [header, "-".repeat(header.length)];
  for (const member of members) {
    lines.push(
      [
        member.member_id.padEnd(memberIdWidth),
        member.email.padEnd(emailWidth),
        (member.name ?? "-").padEnd(nameWidth),
        member.member_role.padEnd(roleWidth),
        member.casbin_roles.length > 0 ? member.casbin_roles.join(", ") : "-",
      ].join("  "),
    );
  }
  lines.push("", `${members.length} of ${total} members (offset: ${offset})`);
  return lines.join("\n");
}

export function registerMembers(
  program: Command,
  dependencies: AccessCommandDependencies = defaultAccessCommandDependencies,
): void {
  const members = program
    .command("members")
    .alias("m")
    .description("Manage organization members");

  members
    .command("list")
    .alias("ls")
    .description("List organization members")
    .option("--role <role>", "filter by organization role")
    .option("--search <query>", "filter by name or email")
    .option("--limit <n>", "maximum number of results", "50")
    .option("--offset <n>", "number of results to skip", "0")
    .action(
      withErrorHandling(
        async (
          commandOptions: {
            role?: string;
            search?: string;
            limit: string;
            offset: string;
          },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const query: {
            limit: string;
            offset: string;
            role?: string;
            q?: string;
          } = {
            limit: commandOptions.limit,
            offset: commandOptions.offset,
          };
          if (commandOptions.role) query.role = commandOptions.role;
          if (commandOptions.search) query.q = commandOptions.search;

          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].members.$get({ param: { orgId }, query });
          const result = await dependencies.handleResponse<{
            status: "ok";
            members: Member[];
            total: number;
            limit: number;
            offset: number;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            memberListOutput(result.members, result.total, result.offset),
          );
        },
      ),
    );

  members
    .command("role-change <member-id>")
    .description("Change an organization member's role")
    .requiredOption("-r, --role <role>", "new role (admin or member)")
    .action(
      withErrorHandling(
        async (
          memberId: string,
          commandOptions: { role: string },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const role = managedRole(commandOptions.role);
          const response = await getAccessApi(client).v1.orgs[":orgId"].members[
            ":memberId"
          ].role.$patch({
            param: { orgId, memberId },
            json: { role },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(
            result,
            options,
            `Changed member ${memberId} role to ${role}`,
          );
        },
      ),
    );

  members
    .command("remove <member-id>")
    .alias("rm")
    .description("Remove a member from the organization")
    .action(
      withErrorHandling(
        async (
          memberId: string,
          _commandOptions: unknown,
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[":orgId"].members[
            ":memberId"
          ].$delete({
            param: { orgId, memberId },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(
            result,
            options,
            `Removed member ${memberId}`,
          );
        },
      ),
    );
}

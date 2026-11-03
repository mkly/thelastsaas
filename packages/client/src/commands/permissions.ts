import type { Command } from "commander";

import { parseJson, withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import type { GlobalOptions } from "../index";
import {
  defaultAccessCommandDependencies,
  getAccessApi,
  type AccessCommandDependencies,
} from "./access-client";

type PolicyAction =
  "read" | "create" | "update" | "write" | "delete" | "manage" | "*";
type InvitationRole = "admin" | "member";

interface Policy {
  subject: string;
  resource: string;
  action: string;
  cond?: string;
  msg?: string;
}

interface RoleAssignment {
  user_id: string;
  role: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function policyAction(value: string): PolicyAction {
  if (
    ["read", "create", "update", "write", "delete", "manage", "*"].includes(
      value,
    )
  ) {
    return value as PolicyAction;
  }
  throw new CliError(
    "--action must be one of read, create, update, write, delete, manage, or *.",
  );
}

function invitationRole(value: string): InvitationRole {
  if (value === "admin" || value === "member") return value;
  throw new CliError("--role must be either admin or member.");
}

function permissionListOutput(
  policies: Policy[],
  roles: RoleAssignment[],
): string {
  const lines = ["Policies:"];
  if (policies.length === 0) {
    lines.push("  (none)");
  } else {
    for (const policy of policies) {
      lines.push(
        `  ${policy.subject.padEnd(24)} ${policy.action.padEnd(8)} ${policy.resource}${policy.cond === undefined ? "" : " cond=" + policy.cond}${policy.msg ? " msg=" + policy.msg : ""}`,
      );
    }
  }

  lines.push("", "Role assignments:");
  if (roles.length === 0) {
    lines.push("  (none)");
  } else {
    for (const role of roles) {
      lines.push(`  ${role.user_id.padEnd(28)} ${role.role}`);
    }
  }
  return lines.join("\n");
}

export function registerPermissions(
  program: Command,
  dependencies: AccessCommandDependencies = defaultAccessCommandDependencies,
): void {
  const permissions = program
    .command("permissions")
    .alias("p")
    .description("Manage policies, roles, invitations, and data filters");

  permissions
    .command("list")
    .alias("ls")
    .description("List policies and role assignments")
    .action(
      withErrorHandling(async (_options: unknown, command: Command) => {
        const options = globalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const response = await getAccessApi(client).v1.orgs[
          ":orgId"
        ].permissions.$get({ param: { orgId } });
        const result = await dependencies.handleResponse<{
          status: "ok";
          policies: Policy[];
          role_assignments: RoleAssignment[];
        }>(response);
        dependencies.writeOutput(
          result,
          options,
          permissionListOutput(result.policies, result.role_assignments),
        );
      }),
    );

  permissions
    .command("grant")
    .description("Add a policy rule")
    .requiredOption(
      "-s, --subject <subject>",
      "subject (role:<name> or user:<id|email>)",
    )
    .requiredOption("-r, --resource <path>", "resource path")
    .requiredOption("-a, --action <action>", "permission action")
    .option("--cond <expression>", "Casbin condition")
    .option("--msg <message>", "Denial message")
    .action(
      withErrorHandling(
        async (
          commandOptions: {
            subject: string;
            resource: string;
            action: string;
            cond?: string;
            msg?: string;
          },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const action = policyAction(commandOptions.action);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions.policies.$post({
            param: { orgId },
            json: {
              subject: commandOptions.subject,
              resource: commandOptions.resource,
              action,
              cond: commandOptions.cond,
              msg: commandOptions.msg,
            },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(
            result,
            options,
            `Granted ${action} on ${commandOptions.resource} to ${commandOptions.subject}`,
          );
        },
      ),
    );

  permissions
    .command("revoke")
    .description("Remove a policy rule")
    .requiredOption(
      "-s, --subject <subject>",
      "subject (role:<name> or user:<id|email>)",
    )
    .requiredOption("-r, --resource <path>", "resource path")
    .requiredOption("-a, --action <action>", "permission action")
    .option("--cond <expression>", "Casbin condition")
    .option("--msg <message>", "Denial message")
    .action(
      withErrorHandling(
        async (
          commandOptions: {
            subject: string;
            resource: string;
            action: string;
            cond?: string;
            msg?: string;
          },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const action = policyAction(commandOptions.action);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions.policies.$delete({
            param: { orgId },
            json: {
              subject: commandOptions.subject,
              resource: commandOptions.resource,
              action,
              cond: commandOptions.cond,
              msg: commandOptions.msg,
            },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(
            result,
            options,
            `Revoked ${action} on ${commandOptions.resource} from ${commandOptions.subject}`,
          );
        },
      ),
    );

  permissions
    .command("assign")
    .description("Assign a user to a Casbin role")
    .requiredOption("-u, --user <id|email>", "user ID or email")
    .requiredOption("-r, --role <name>", "role name")
    .action(
      withErrorHandling(
        async (
          commandOptions: { user: string; role: string },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions.roles.$post({
            param: { orgId },
            json: { user_id: commandOptions.user, role: commandOptions.role },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(
            result,
            options,
            `Assigned ${commandOptions.user} to role ${commandOptions.role}`,
          );
        },
      ),
    );

  permissions
    .command("unassign")
    .description("Remove a user from a Casbin role")
    .requiredOption("-u, --user <id|email>", "user ID or email")
    .requiredOption("-r, --role <name>", "role name")
    .action(
      withErrorHandling(
        async (
          commandOptions: { user: string; role: string },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions.roles.$delete({
            param: { orgId },
            json: { user_id: commandOptions.user, role: commandOptions.role },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(
            result,
            options,
            `Removed ${commandOptions.user} from role ${commandOptions.role}`,
          );
        },
      ),
    );

  permissions
    .command("check")
    .description("Check whether a user has a permission")
    .requiredOption("-u, --user <id|email>", "user ID or email")
    .requiredOption("-r, --resource <path>", "resource path")
    .requiredOption("-a, --action <action>", "permission action")
    .action(
      withErrorHandling(
        async (
          commandOptions: {
            user: string;
            resource: string;
            action: string;
          },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions.check.$post({
            param: { orgId },
            json: {
              user_id: commandOptions.user,
              resource: commandOptions.resource,
              action: policyAction(commandOptions.action),
            },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            allowed: boolean;
            conditional?: boolean;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            result.allowed
              ? result.conditional
                ? "ALLOWED subject to row/field conditions"
                : "ALLOWED"
              : "DENIED",
          );
        },
      ),
    );

  registerInvitationCommands(permissions, dependencies);
}

function registerInvitationCommands(
  permissions: Command,
  dependencies: AccessCommandDependencies,
): void {
  permissions
    .command("invite")
    .description("Invite a user to the organization")
    .requiredOption("-e, --email <email>", "email address")
    .option("-r, --role <role>", "organization role", "member")
    .option(
      "--permissions <json>",
      "permission grants to apply when the invitation is accepted",
    )
    .action(
      withErrorHandling(
        async (
          commandOptions: { email: string; role: string; permissions?: string },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].invitations.$post({
            param: { orgId },
            json: {
              email: commandOptions.email,
              role: invitationRole(commandOptions.role),
              ...(commandOptions.permissions === undefined
                ? {}
                : {
                    permissions: parseJson(
                      commandOptions.permissions,
                      "permissions",
                    ),
                  }),
            },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            invitation_id: string;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            `Invited ${commandOptions.email} (${result.invitation_id})`,
          );
        },
      ),
    );

  permissions
    .command("invitations")
    .description("List pending organization invitations")
    .action(
      withErrorHandling(async (_options: unknown, command: Command) => {
        const options = globalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const response = await getAccessApi(client).v1.orgs[
          ":orgId"
        ].invitations.$get({ param: { orgId } });
        const result = await dependencies.handleResponse<{
          status: "ok";
          invitations: Invitation[];
        }>(response);
        const human =
          result.invitations.length === 0
            ? "No pending invitations."
            : result.invitations
                .map(
                  (invitation) =>
                    `  ${invitation.email.padEnd(30)} ${(invitation.role ?? "member").padEnd(8)} ${invitation.id}`,
                )
                .join("\n");
        dependencies.writeOutput(result, options, human);
      }),
    );

  permissions
    .command("accept-invite")
    .description("Accept an organization invitation")
    .requiredOption("-i, --id <invitation-id>", "invitation ID")
    .action(
      withErrorHandling(
        async (commandOptions: { id: string }, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].invitations.accept.$post({
            param: { orgId },
            json: { invitation_id: commandOptions.id },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(result, options, "Invitation accepted");
        },
      ),
    );

  permissions
    .command("cancel-invite")
    .description("Cancel a pending organization invitation")
    .requiredOption("-i, --id <invitation-id>", "invitation ID")
    .action(
      withErrorHandling(
        async (commandOptions: { id: string }, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].invitations.cancel.$post({
            param: { orgId },
            json: { invitation_id: commandOptions.id },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(result, options, "Invitation cancelled");
        },
      ),
    );
}

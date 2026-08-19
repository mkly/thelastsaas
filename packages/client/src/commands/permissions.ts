import type { Command } from "commander";

import { parseJson, withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import type { GlobalOptions } from "../index";
import {
  defaultAccessCommandDependencies,
  getAccessApi,
  type AccessCommandDependencies,
} from "./access-client";

type PolicyAction = "read" | "write" | "delete" | "manage" | "*";
type FilterAction = "read" | "write" | "delete";
type InvitationRole = "admin" | "member";

interface Policy {
  subject: string;
  resource: string;
  action: string;
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

interface RowFilter {
  id: string;
  collection: string;
  role: string;
  action: string;
  condition: unknown;
}

interface FieldFilter {
  id: string;
  collection: string;
  role: string;
  action: string;
  readable_fields: string[];
  writable_fields: string[];
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function policyAction(value: string): PolicyAction {
  if (["read", "write", "delete", "manage", "*"].includes(value)) {
    return value as PolicyAction;
  }
  throw new CliError(
    "--action must be one of read, write, delete, manage, or *.",
  );
}

function filterAction(value: string): FilterAction {
  if (["read", "write", "delete"].includes(value)) {
    return value as FilterAction;
  }
  throw new CliError("--action must be one of read, write, or delete.");
}

function invitationRole(value: string): InvitationRole {
  if (value === "admin" || value === "member") return value;
  throw new CliError("--role must be either admin or member.");
}

function fieldNames(value: string, label: string): string[] {
  const parsed = parseJson<unknown>(value, label);
  if (
    !Array.isArray(parsed) ||
    parsed.some((field) => typeof field !== "string" || !field.trim())
  ) {
    throw new CliError(`${label} must be a JSON array of field names.`);
  }
  return parsed;
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
        `  ${policy.subject.padEnd(24)} ${policy.action.padEnd(8)} ${policy.resource}`,
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
    .action(
      withErrorHandling(
        async (
          commandOptions: {
            subject: string;
            resource: string;
            action: string;
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
    .action(
      withErrorHandling(
        async (
          commandOptions: {
            subject: string;
            resource: string;
            action: string;
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
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            result.allowed ? "ALLOWED" : "DENIED",
          );
        },
      ),
    );

  registerInvitationCommands(permissions, dependencies);
  registerRowFilterCommands(permissions, dependencies);
  registerFieldFilterCommands(permissions, dependencies);
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
    .action(
      withErrorHandling(
        async (
          commandOptions: { email: string; role: string },
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

function registerRowFilterCommands(
  permissions: Command,
  dependencies: AccessCommandDependencies,
): void {
  const rowFilters = permissions
    .command("row-filter")
    .description("Manage row-level permission filters");

  rowFilters
    .command("set")
    .description("Create or replace a row filter")
    .requiredOption("-c, --collection <name>", "collection name")
    .requiredOption("-r, --role <name>", "role name")
    .requiredOption("-a, --action <action>", "read, write, or delete")
    .requiredOption("--condition <json>", "Where condition as JSON")
    .action(
      withErrorHandling(
        async (
          commandOptions: {
            collection: string;
            role: string;
            action: string;
            condition: string;
          },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions["row-filters"].$post({
            param: { orgId },
            json: {
              collection: commandOptions.collection,
              role: commandOptions.role,
              action: filterAction(commandOptions.action),
              condition: parseJson<Record<string, unknown>>(
                commandOptions.condition,
                "--condition",
              ),
            },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            id: string;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            `Row filter set (${result.id})`,
          );
        },
      ),
    );

  rowFilters
    .command("list")
    .alias("ls")
    .description("List row filters")
    .option("-c, --collection <name>", "filter by collection")
    .action(
      withErrorHandling(
        async (commandOptions: { collection?: string }, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions["row-filters"].$get({
            param: { orgId },
            query: commandOptions.collection
              ? { collection: commandOptions.collection }
              : {},
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            row_filters: RowFilter[];
          }>(response);
          const human =
            result.row_filters.length === 0
              ? "No row filters."
              : result.row_filters
                  .map(
                    (filter) =>
                      `  ${filter.id}  ${filter.collection.padEnd(20)} ${filter.role.padEnd(16)} ${filter.action.padEnd(8)} ${JSON.stringify(filter.condition)}`,
                  )
                  .join("\n");
          dependencies.writeOutput(result, options, human);
        },
      ),
    );

  rowFilters
    .command("delete <id>")
    .alias("rm")
    .description("Delete a row filter")
    .action(
      withErrorHandling(
        async (id: string, _commandOptions: unknown, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions["row-filters"][":id"].$delete({
            param: { orgId, id },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(result, options, `Deleted row filter ${id}`);
        },
      ),
    );
}

function registerFieldFilterCommands(
  permissions: Command,
  dependencies: AccessCommandDependencies,
): void {
  const fieldFilters = permissions
    .command("field-filter")
    .description("Manage field-level permission filters");

  fieldFilters
    .command("set")
    .description("Create or replace a field filter")
    .requiredOption("-c, --collection <name>", "collection name")
    .requiredOption("-r, --role <name>", "role name")
    .requiredOption("-a, --action <action>", "read, write, or delete")
    .requiredOption(
      "--readable-fields <json>",
      "readable field names as a JSON array",
    )
    .requiredOption(
      "--writable-fields <json>",
      "writable field names as a JSON array",
    )
    .action(
      withErrorHandling(
        async (
          commandOptions: {
            collection: string;
            role: string;
            action: string;
            readableFields: string;
            writableFields: string;
          },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions["field-filters"].$post({
            param: { orgId },
            json: {
              collection: commandOptions.collection,
              role: commandOptions.role,
              action: filterAction(commandOptions.action),
              readable_fields: fieldNames(
                commandOptions.readableFields,
                "--readable-fields",
              ),
              writable_fields: fieldNames(
                commandOptions.writableFields,
                "--writable-fields",
              ),
            },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            id: string;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            `Field filter set (${result.id})`,
          );
        },
      ),
    );

  fieldFilters
    .command("list")
    .alias("ls")
    .description("List field filters")
    .option("-c, --collection <name>", "filter by collection")
    .action(
      withErrorHandling(
        async (commandOptions: { collection?: string }, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions["field-filters"].$get({
            param: { orgId },
            query: commandOptions.collection
              ? { collection: commandOptions.collection }
              : {},
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            field_filters: FieldFilter[];
          }>(response);
          const human =
            result.field_filters.length === 0
              ? "No field filters."
              : result.field_filters
                  .map(
                    (filter) =>
                      `  ${filter.id}  ${filter.collection.padEnd(20)} ${filter.role.padEnd(16)} ${filter.action.padEnd(8)} read=[${filter.readable_fields.join(",")}] write=[${filter.writable_fields.join(",")}]`,
                  )
                  .join("\n");
          dependencies.writeOutput(result, options, human);
        },
      ),
    );

  fieldFilters
    .command("delete <id>")
    .alias("rm")
    .description("Delete a field filter")
    .action(
      withErrorHandling(
        async (id: string, _commandOptions: unknown, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getAccessApi(client).v1.orgs[
            ":orgId"
          ].permissions["field-filters"][":id"].$delete({
            param: { orgId, id },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(
            result,
            options,
            `Deleted field filter ${id}`,
          );
        },
      ),
    );
}

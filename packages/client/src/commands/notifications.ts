import {
  notifySchema,
  type NotifyResponse,
  type Notification,
  type NotificationSchedule,
  type NotificationAudience,
} from "@lastsaas/shared";
import type { Command } from "commander";

import { parseJson, withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import type { GlobalOptions } from "../index";
import {
  defaultOperationsCommandDependencies,
  getOperationsApi,
  type OperationsCommandDependencies,
} from "./operations-client";

const NOTIFICATION_KINDS = [
  "invitation",
  "role_assigned",
  "role_unassigned",
  "member_removed",
] as const;

type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

interface NotificationPreferences {
  default: { in_app: boolean; email: boolean };
  by_kind: Partial<
    Record<NotificationKind, { in_app: boolean; email: boolean }>
  >;
}

export interface NotificationsCommandDependencies extends OperationsCommandDependencies {
  parseJson: typeof parseJson;
}

const defaultDependencies: NotificationsCommandDependencies = {
  ...defaultOperationsCommandDependencies,
  parseJson,
};

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function toggle(value: string, label: string): boolean {
  if (["on", "true", "yes", "1"].includes(value.toLowerCase())) return true;
  if (["off", "false", "no", "0"].includes(value.toLowerCase())) return false;
  throw new CliError(
    `${label} must be one of on/off, true/false, yes/no, or 1/0.`,
  );
}

function notificationsOutput(notifications: Notification[]): string {
  if (notifications.length === 0) return "No notifications.";
  return notifications
    .map((notification) => {
      const marker = notification.read ? " " : "*";
      return `${marker} [${notification.type}] ${notification.message}  (${notification.id})`;
    })
    .join("\n");
}

function preferencesOutput(preferences: NotificationPreferences): string {
  const lines = [
    `default: in_app=${preferences.default.in_app ? "on" : "off"} email=${preferences.default.email ? "on" : "off"}`,
  ];
  for (const kind of NOTIFICATION_KINDS) {
    const preference = preferences.by_kind[kind];
    if (preference) {
      lines.push(
        `${kind}: in_app=${preference.in_app ? "on" : "off"} email=${preference.email ? "on" : "off"}`,
      );
    }
  }
  return lines.join("\n");
}

function scheduleOutput(schedules: NotificationSchedule[]): string {
  if (schedules.length === 0) return "No notification schedules.";
  return schedules
    .map((schedule) => {
      const timing =
        schedule.kind === "recurring"
          ? schedule.recurrence
          : schedule.deliver_at;
      const audience = schedule.audience ?? { kind: "self" };
      const destination =
        audience.kind === "users"
          ? audience.users.join(", ")
          : audience.kind === "roles"
            ? `roles: ${audience.roles.join(", ")}`
            : audience.kind === "all"
              ? "everyone"
              : "self";
      return `  ${schedule.id.padEnd(24)} ${schedule.kind.padEnd(10)} ${schedule.enabled ? "enabled " : "disabled"} ${timing ?? "-"}  ${schedule.message}  (to ${destination})`;
    })
    .join("\n");
}

function preferencePatch(options: { inApp?: string; email?: string }): {
  in_app?: boolean;
  email?: boolean;
} {
  const patch = {
    ...(options.inApp === undefined
      ? {}
      : { in_app: toggle(options.inApp, "--in-app") }),
    ...(options.email === undefined
      ? {}
      : { email: toggle(options.email, "--email") }),
  };
  if (patch.in_app === undefined && patch.email === undefined) {
    throw new CliError("Provide at least one of --in-app or --email.");
  }
  return patch;
}

interface AudienceOptions {
  to?: string[];
  toRole?: string[];
  toAll?: boolean;
}

function audienceBody(options: AudienceOptions): {
  audience?: NotificationAudience;
} {
  const users = options.to ?? [];
  const roles = options.toRole ?? [];
  if (
    Number(users.length > 0) +
      Number(roles.length > 0) +
      Number(Boolean(options.toAll)) >
    1
  ) {
    throw new CliError("Choose one audience: --to, --to-role, or --to-all.");
  }
  if (users.length) return { audience: { kind: "users", users } };
  if (roles.length) return { audience: { kind: "roles", roles } };
  if (options.toAll) return { audience: { kind: "all" } };
  return {};
}

function addAudienceOptions(command: Command): Command {
  const collect = (value: string, previous: string[]) => [...previous, value];
  return command
    .option(
      "--to <member>",
      "Recipient user ID or email; repeat for multiple people",
      collect,
      [],
    )
    .option(
      "--to-role <role>",
      "Notify members of this role; repeat for multiple roles",
      collect,
      [],
    )
    .option("--to-all", "Notify all human organization members, including you");
}

export function registerNotifications(
  program: Command,
  dependencies: NotificationsCommandDependencies = defaultDependencies,
): void {
  const notifications = program
    .command("notifications")
    .alias("n")
    .description("Manage notifications and schedules");

  notifications
    .command("list")
    .alias("ls")
    .description("List notifications")
    .option("--unread", "Show only unread notifications")
    .action(
      withErrorHandling(
        async (commandOptions: { unread?: boolean }, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].notifications.$get({
            param: { orgId },
            query: commandOptions.unread ? { unread: "true" } : {},
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            notifications: Notification[];
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            notificationsOutput(result.notifications),
          );
        },
      ),
    );

  for (const [name, read] of [
    ["read", true],
    ["unread", false],
  ] as const) {
    notifications
      .command(`${name} <id>`)
      .description(`Mark a notification as ${name}`)
      .action(
        withErrorHandling(
          async (id: string, _commandOptions, command: Command) => {
            const options = globalOptions(command);
            const { client, orgId } = dependencies.getOrgClient(options);
            const response = await getOperationsApi(client).v1.orgs[
              ":orgId"
            ].notifications[":id"].$patch({
              param: { orgId, id },
              json: { read },
            });
            const result = await dependencies.handleResponse(response);
            dependencies.writeOutput(
              result,
              options,
              `Marked notification ${id} as ${name}`,
            );
          },
        ),
      );
  }

  notifications
    .command("delete <id>")
    .alias("rm")
    .description("Delete a notification")
    .action(
      withErrorHandling(
        async (id: string, _commandOptions, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].notifications[":id"].$delete({ param: { orgId, id } });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(
            result,
            options,
            `Deleted notification ${id}`,
          );
        },
      ),
    );

  addAudienceOptions(program.command("notify"))
    .description(
      "Notify people now or on a schedule using their channel preferences",
    )
    .requiredOption("--subject <text>", "Notification subject")
    .option("--message <text>", "Notification body (defaults to subject)")
    .option("--type <type>", "Notification type")
    .option("--data <json>", "Notification payload")
    .option("--dedupe-key <key>", "Retry key scoped to your account")
    .option("--at <datetime>", "Send once at a UTC timestamp")
    .option("--recurrence <content>", "RFC 5545 DTSTART/RRULE/EXDATE content")
    .action(
      withErrorHandling(
        async (
          input: AudienceOptions & {
            subject: string;
            message?: string;
            type?: string;
            data?: string;
            dedupeKey?: string;
            at?: string;
            recurrence?: string;
          },
          command: Command,
        ) => {
          if (input.at && input.recurrence)
            throw new CliError("Choose either --at or --recurrence.");
          const body = notifySchema.safeParse({
            ...audienceBody(input),
            subject: input.subject,
            message: input.message,
            type: input.type,
            ...(input.data
              ? { data: dependencies.parseJson(input.data, "--data") }
              : {}),
            dedupe_key: input.dedupeKey,
            ...(input.at
              ? { timing: { kind: "once", at: input.at } }
              : input.recurrence
                ? {
                    timing: { kind: "recurring", recurrence: input.recurrence },
                  }
                : {}),
          });
          if (!body.success)
            throw new CliError("Invalid notification content or timing.");
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const result = await dependencies.handleResponse<NotifyResponse>(
            await getOperationsApi(client).v1.orgs[
              ":orgId"
            ].notifications.notify.$post({ param: { orgId }, json: body.data }),
          );
          dependencies.writeOutput(
            result,
            options,
            result.kind === "scheduled"
              ? `Scheduled notification ${result.schedule.id}`
              : `Notification queued: ${result.queued_count} recipients, ${result.skipped_count} skipped`,
          );
        },
      ),
    );

  const schedules = notifications
    .command("schedules")
    .alias("schedule")
    .description("Manage one-shot and recurring notification schedules");

  schedules
    .command("list")
    .alias("ls")
    .description("List notification schedules")
    .action(
      withErrorHandling(async (_commandOptions, command: Command) => {
        const options = globalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const response = await getOperationsApi(client).v1.orgs[
          ":orgId"
        ].notifications.schedules.$get({ param: { orgId } });
        const result = await dependencies.handleResponse<{
          status: "ok";
          schedules: NotificationSchedule[];
        }>(response);
        dependencies.writeOutput(
          result,
          options,
          scheduleOutput(result.schedules),
        );
      }),
    );

  schedules
    .command("cancel <id>")
    .alias("rm")
    .description("Cancel a notification schedule")
    .action(
      withErrorHandling(
        async (id: string, _commandOptions, command: Command) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].notifications.schedules[":id"].$delete({
            param: { orgId, id },
          });
          const result = await dependencies.handleResponse(response);
          dependencies.writeOutput(
            result,
            options,
            `Cancelled notification schedule ${id}`,
          );
        },
      ),
    );

  const preferences = notifications
    .command("preferences")
    .alias("prefs")
    .description("Manage notification channel preferences");

  preferences
    .command("show")
    .description("Show notification preferences")
    .action(
      withErrorHandling(async (_commandOptions, command: Command) => {
        const options = globalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const response = await getOperationsApi(client).v1.orgs[
          ":orgId"
        ].notifications.preferences.$get({ param: { orgId } });
        const result = await dependencies.handleResponse<{
          status: "ok";
          preferences: NotificationPreferences;
        }>(response);
        dependencies.writeOutput(
          result,
          options,
          preferencesOutput(result.preferences),
        );
      }),
    );

  preferences
    .command("set-default")
    .description("Set default notification preferences")
    .option("--in-app <state>", "Default in-app delivery")
    .option("--email <state>", "Default email delivery")
    .action(
      withErrorHandling(
        async (
          commandOptions: { inApp?: string; email?: string },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].notifications.preferences.$patch({
            param: { orgId },
            json: { default: preferencePatch(commandOptions) },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            preferences: NotificationPreferences;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            preferencesOutput(result.preferences),
          );
        },
      ),
    );

  preferences
    .command("set-kind <kind>")
    .description("Set preferences for one notification kind")
    .option("--in-app <state>", "In-app delivery")
    .option("--email <state>", "Email delivery")
    .action(
      withErrorHandling(
        async (
          kind: string,
          commandOptions: { inApp?: string; email?: string },
          command: Command,
        ) => {
          if (!NOTIFICATION_KINDS.some((candidate) => candidate === kind)) {
            throw new CliError(
              `Kind must be one of ${NOTIFICATION_KINDS.join(", ")}.`,
            );
          }
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].notifications.preferences.$patch({
            param: { orgId },
            json: { by_kind: { [kind]: preferencePatch(commandOptions) } },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            preferences: NotificationPreferences;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            preferencesOutput(result.preferences),
          );
        },
      ),
    );
}

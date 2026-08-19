import { type Notification, type NotificationSchedule } from "@lastsaas/shared";
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
      return `  ${schedule.id.padEnd(24)} ${schedule.kind.padEnd(10)} ${schedule.enabled ? "enabled " : "disabled"} ${timing ?? "-"}  ${schedule.message}`;
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

interface DeliveryOptions {
  message: string;
  type: string;
  data?: string;
  inApp?: string;
  channel?: string;
  dedupeKey?: string;
}

function deliveryBody(
  options: DeliveryOptions,
  dependencies: NotificationsCommandDependencies,
): Record<string, unknown> {
  return {
    message: options.message,
    type: options.type,
    ...(options.data
      ? { data: dependencies.parseJson(options.data, "--data") }
      : {}),
    ...(options.inApp === undefined
      ? {}
      : { in_app: toggle(options.inApp, "--in-app") }),
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.dedupeKey ? { dedupe_key: options.dedupeKey } : {}),
  };
}

function addDeliveryOptions(command: Command): Command {
  return command
    .requiredOption("--message <text>", "Notification message")
    .option("--type <type>", "Notification type", "direct_notification")
    .option("--data <json>", "Notification payload as JSON")
    .option("--in-app <state>", "Whether to expose it in-app")
    .option("--channel <name>", "Delivery channel")
    .option("--dedupe-key <key>", "Stable delivery deduplication key");
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

  notifications
    .command("queue")
    .description("Queue a notification for immediate delivery")
    .requiredOption("--subject <text>", "Email subject")
    .option("--message <text>", "In-app notification message")
    .option("--text <text>", "Plain-text email body")
    .option("--html <html>", "HTML email body")
    .option("--data <json>", "Notification payload as JSON")
    .option("--type <type>", "Notification type", "direct_notification")
    .option("--in-app <state>", "Whether to expose it in-app")
    .option("--channel <name>", "Delivery channel")
    .action(
      withErrorHandling(
        async (
          commandOptions: {
            subject: string;
            message?: string;
            text?: string;
            html?: string;
            data?: string;
            type: string;
            inApp?: string;
            channel?: string;
          },
          command: Command,
        ) => {
          const options = globalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const response = await getOperationsApi(client).v1.orgs[
            ":orgId"
          ].notifications.queue.$post({
            param: { orgId },
            json: {
              subject: commandOptions.subject,
              type: commandOptions.type,
              ...(commandOptions.message
                ? { message: commandOptions.message }
                : {}),
              ...(commandOptions.text ? { text: commandOptions.text } : {}),
              ...(commandOptions.html ? { html: commandOptions.html } : {}),
              ...(commandOptions.data
                ? {
                    data: dependencies.parseJson(commandOptions.data, "--data"),
                  }
                : {}),
              ...(commandOptions.inApp === undefined
                ? {}
                : { in_app: toggle(commandOptions.inApp, "--in-app") }),
              ...(commandOptions.channel
                ? { channel: commandOptions.channel }
                : {}),
            },
          });
          const result = await dependencies.handleResponse<{
            status: "ok";
            id: string;
            message: string;
          }>(response);
          dependencies.writeOutput(
            result,
            options,
            `${result.message} (${result.id})`,
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

  addDeliveryOptions(
    schedules
      .command("once")
      .description("Schedule one notification")
      .requiredOption("--at <datetime>", "ISO-8601 delivery time"),
  ).action(
    withErrorHandling(
      async (
        commandOptions: DeliveryOptions & { at: string },
        command: Command,
      ) => {
        const options = globalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const response = await getOperationsApi(client).v1.orgs[
          ":orgId"
        ].notifications.schedules.$post({
          param: { orgId },
          json: {
            ...deliveryBody(commandOptions, dependencies),
            deliver_at: commandOptions.at,
          },
        });
        const result = await dependencies.handleResponse<
          NotificationSchedule & { status: "ok" }
        >(response);
        dependencies.writeOutput(
          result,
          options,
          `Scheduled one-shot notification ${result.id}`,
        );
      },
    ),
  );

  addDeliveryOptions(
    schedules
      .command("recurring")
      .description("Schedule recurring notifications")
      .requiredOption(
        "--recurrence <content>",
        "RFC 5545 DTSTART/RRULE/EXDATE content",
      ),
  ).action(
    withErrorHandling(
      async (
        commandOptions: DeliveryOptions & { recurrence: string },
        command: Command,
      ) => {
        const options = globalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const response = await getOperationsApi(client).v1.orgs[
          ":orgId"
        ].notifications.schedules.$post({
          param: { orgId },
          json: {
            ...deliveryBody(commandOptions, dependencies),
            recurrence: commandOptions.recurrence,
          },
        });
        const result = await dependencies.handleResponse<
          NotificationSchedule & { status: "ok" }
        >(response);
        dependencies.writeOutput(
          result,
          options,
          `Scheduled recurring notification ${result.id}`,
        );
      },
    ),
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

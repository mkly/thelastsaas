import type { PrismaClient } from "@prisma/client";

import type { AppConfig } from "../config";
import { log } from "../logger";
import {
  ConsoleChannel,
  EmailChannel,
  NotificationDispatcher,
  type NotificationChannel,
} from "./channels";
import { NotificationQueue } from "./queue";

export function createNotificationServices(
  prisma: PrismaClient,
  config: AppConfig,
  channels?: NotificationChannel[],
): {
  notifications: NotificationDispatcher;
  notificationQueue: NotificationQueue;
} {
  const configuredChannels = channels ?? [new ConsoleChannel()];
  if (!channels && config.smtpHost) {
    const email = new EmailChannel({
      host: config.smtpHost,
      port: config.smtpPort,
      user: config.smtpUser,
      pass: config.smtpPass,
      from: config.smtpFrom,
    });
    configuredChannels.push(email);
    /* Fire-and-forget: surfaces a bad SMTP host/credential in the logs at
       startup instead of on the first delivery attempt. */
    void email.verify();
  }
  if (!channels) {
    log.info(
      "notifications",
      config.smtpHost
        ? `email channel enabled via ${config.smtpHost}:${config.smtpPort}, from ${config.smtpFrom}`
        : "SMTP not configured (SMTP_HOST unset) — notifications and auth emails only reach the console channel",
    );
  }
  const notifications = new NotificationDispatcher(configuredChannels);
  return {
    notifications,
    notificationQueue: new NotificationQueue(prisma, notifications),
  };
}

export * from "./channels";
export * from "./preferences";
export * from "./queue";

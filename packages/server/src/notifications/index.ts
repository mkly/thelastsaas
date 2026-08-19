import type { PrismaClient } from "@prisma/client";

import type { AppConfig } from "../config";
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
    configuredChannels.push(
      new EmailChannel({
        host: config.smtpHost,
        port: config.smtpPort,
        user: config.smtpUser,
        pass: config.smtpPass,
        from: config.smtpFrom,
      }),
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

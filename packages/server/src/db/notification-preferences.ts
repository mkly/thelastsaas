import type {
  NotificationPreferences,
  NotificationPreferencesPatch,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  mergeNotificationPreferences,
  normalizeNotificationPreferences,
} from "../notifications/preferences";

export async function getNotificationPreferences(
  prisma: PrismaClient,
  userId: string,
): Promise<NotificationPreferences> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreferences: true },
  });
  if (!user) throw new Error(`User '${userId}' not found`);
  return normalizeNotificationPreferences(user.notificationPreferences);
}

export async function updateNotificationPreferences(
  prisma: PrismaClient,
  userId: string,
  patch: NotificationPreferencesPatch,
): Promise<NotificationPreferences> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreferences: true },
  });
  if (!user) throw new Error(`User '${userId}' not found`);

  const preferences = mergeNotificationPreferences(
    user.notificationPreferences,
    patch,
  );
  await prisma.user.update({
    where: { id: userId },
    data: {
      notificationPreferences: preferences as unknown as Prisma.InputJsonValue,
    },
  });
  return preferences;
}

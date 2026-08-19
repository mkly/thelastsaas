import {
  genId,
  type NotificationKind,
  type NotificationPayloads,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  normalizeNotificationMessage,
  type NotificationMessage,
} from "../notifications/channels";
import { resolveNotificationChannels } from "../notifications/preferences";
import type {
  NotificationQueue,
  QueueNotificationInput,
} from "../notifications/queue";

const DELIVERY_DATA_KEY = "__delivery";

export interface QueuedDelivery extends NotificationMessage {
  channels?: string[];
}

export interface NotificationWriteOptions {
  inApp?: boolean;
  dedupeKey?: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toJson(value: object): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function attachDelivery(
  data: object | undefined,
  delivery: QueuedDelivery,
): Prisma.InputJsonValue {
  return toJson({
    ...(data ?? {}),
    [DELIVERY_DATA_KEY]: {
      to: delivery.to,
      subject: delivery.subject,
      text: delivery.text,
      ...(delivery.html ? { html: delivery.html } : {}),
      ...(delivery.channels?.length ? { channels: delivery.channels } : {}),
    },
  });
}

export function extractQueuedDelivery(value: unknown): QueuedDelivery | null {
  const delivery = asObject(asObject(value)[DELIVERY_DATA_KEY]);
  if (
    typeof delivery.to !== "string" ||
    typeof delivery.subject !== "string" ||
    typeof delivery.text !== "string"
  ) {
    return null;
  }

  const channels = Array.isArray(delivery.channels)
    ? delivery.channels.filter(
        (channel): channel is string => typeof channel === "string",
      )
    : undefined;
  return {
    to: delivery.to,
    subject: delivery.subject,
    text: delivery.text,
    ...(typeof delivery.html === "string" ? { html: delivery.html } : {}),
    ...(channels?.length ? { channels } : {}),
  };
}

function stripInternalData(value: unknown): Record<string, unknown> | null {
  const entries = Object.entries(asObject(value)).filter(
    ([key]) => key !== DELIVERY_DATA_KEY,
  );
  return entries.length ? Object.fromEntries(entries) : null;
}

export async function createNotification(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  type: string,
  message: string,
  data?: object,
  options: NotificationWriteOptions = {},
) {
  const create = {
    id: genId(),
    orgId,
    userId,
    type,
    message,
    ...(data ? { data: toJson(data) } : {}),
    ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
    inApp: options.inApp ?? true,
    status: "sent",
  };

  if (options.dedupeKey) {
    return prisma.notification.upsert({
      where: {
        orgId_userId_dedupeKey: {
          orgId,
          userId,
          dedupeKey: options.dedupeKey,
        },
      },
      create,
      update: {},
    });
  }
  return prisma.notification.create({ data: create });
}

const queueSelect = {
  id: true,
  status: true,
  nextAttemptAt: true,
} satisfies Prisma.NotificationSelect;

export async function enqueueNotification(
  prisma: PrismaClient,
  input: QueueNotificationInput,
): Promise<{ id: string; status: string; nextAttemptAt: Date | null }> {
  const create = {
    id: genId(),
    orgId: input.orgId,
    userId: input.userId,
    type: input.type,
    message: input.message,
    data: attachDelivery(input.data, input.delivery),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    inApp: input.inApp ?? true,
    channel: input.delivery.channels?.join(",") ?? "console",
    status: "pending",
    nextAttemptAt: new Date(),
  };

  if (!input.dedupeKey) {
    return prisma.notification.create({ data: create, select: queueSelect });
  }

  const where = {
    orgId_userId_dedupeKey: {
      orgId: input.orgId,
      userId: input.userId,
      dedupeKey: input.dedupeKey,
    },
  } as const;
  const existing = await prisma.notification.findUnique({
    where,
    select: queueSelect,
  });
  if (existing) return existing;

  try {
    return await prisma.notification.create({
      data: create,
      select: queueSelect,
    });
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    ) {
      throw error;
    }
    const concurrent = await prisma.notification.findUnique({
      where,
      select: queueSelect,
    });
    if (!concurrent) throw error;
    return concurrent;
  }
}

const messageBuilders: {
  [Kind in NotificationKind]: (payload: NotificationPayloads[Kind]) => string;
} = {
  invitation: (payload) =>
    `You've been invited to join "${payload.organization_name ?? "an organization"}" as ${payload.role}`,
  role_assigned: (payload) => `You were assigned to role '${payload.role}'`,
  role_unassigned: (payload) => `You were removed from role '${payload.role}'`,
  member_removed: () => "You were removed from the organization",
};

export async function emitNotification<Kind extends NotificationKind>(
  prisma: PrismaClient,
  queue: NotificationQueue,
  orgId: string,
  userId: string,
  kind: Kind,
  payload: NotificationPayloads[Kind],
  options: NotificationWriteOptions = {},
): Promise<string | null> {
  const recipient = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, notificationPreferences: true },
  });
  if (!recipient) throw new Error(`User '${userId}' not found`);

  const preferences = resolveNotificationChannels(
    recipient.notificationPreferences,
    kind,
  );
  if (!preferences.in_app && !preferences.email) return null;

  const message = messageBuilders[kind](payload);
  if (!preferences.email) {
    const row = await createNotification(
      prisma,
      orgId,
      userId,
      kind,
      message,
      payload,
      options,
    );
    return row.id;
  }

  return queue.enqueue({
    orgId,
    userId,
    type: kind,
    message,
    data: payload,
    inApp: preferences.in_app,
    dedupeKey: options.dedupeKey,
    delivery: normalizeNotificationMessage({
      to: recipient.email,
      subject: message,
      text: message,
    }),
  });
}

export interface DirectNotificationInput {
  type?: string;
  message?: string;
  subject: string;
  text?: string;
  html?: string;
  data?: object;
  inApp?: boolean;
  channel?: string;
  dedupeKey?: string;
}

export async function queueDirectNotification(
  prisma: PrismaClient,
  queue: NotificationQueue,
  orgId: string,
  userId: string,
  input: DirectNotificationInput,
): Promise<string> {
  const recipient = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!recipient) throw new Error(`User '${userId}' not found`);

  const message = input.message ?? input.text ?? input.subject;
  return queue.enqueue({
    orgId,
    userId,
    type: input.type ?? "direct_notification",
    message,
    ...(input.data ? { data: input.data } : {}),
    inApp: input.inApp ?? true,
    dedupeKey: input.dedupeKey,
    delivery: {
      ...normalizeNotificationMessage({
        to: recipient.email,
        subject: input.subject,
        text: input.text ?? message,
        ...(input.html ? { html: input.html } : {}),
      }),
      ...(input.channel ? { channels: [input.channel] } : {}),
    },
  });
}

export async function getNotifications(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  unreadOnly: boolean,
) {
  const rows = await prisma.notification.findMany({
    where: {
      orgId,
      userId,
      inApp: true,
      ...(unreadOnly ? { read: false } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      message: true,
      data: true,
      read: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    message: row.message,
    data: stripInternalData(row.data),
    read: row.read,
    created_at: row.createdAt.toISOString(),
  }));
}

export function markNotificationRead(
  prisma: PrismaClient,
  id: string,
  orgId: string,
  userId: string,
  read: boolean,
) {
  return prisma.notification.updateMany({
    where: { id, orgId, userId, inApp: true },
    data: { read },
  });
}

export function deleteNotification(
  prisma: PrismaClient,
  id: string,
  orgId: string,
  userId: string,
) {
  return prisma.notification.deleteMany({
    where: { id, orgId, userId, inApp: true },
  });
}

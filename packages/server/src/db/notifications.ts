import {
  genId,
  type NotificationKind,
  type NotificationPayloads,
  type NotificationAudience,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  deriveNotificationSubject,
  normalizeNotificationMessage,
  type NotificationMessage,
} from "../notifications/channels";
import {
  applyRecipientPreferences,
  resolveNotificationChannels,
} from "../notifications/preferences";
import type {
  NotificationQueue,
  QueueNotificationInput,
} from "../notifications/queue";
import {
  resolveNotificationAudience,
  type NotificationRecipient,
} from "./notification-audiences";

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
} satisfies Prisma.NotificationSelect;

export async function enqueueNotification(
  prisma: Prisma.TransactionClient,
  input: QueueNotificationInput,
): Promise<{ id: string; status: string }> {
  const create = {
    id: genId(),
    orgId: input.orgId,
    userId: input.userId,
    ...(input.createdByUserId
      ? { createdByUserId: input.createdByUserId }
      : {}),
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input.occurrenceAt ? { occurrenceAt: input.occurrenceAt } : {}),
    type: input.type,
    message: input.message,
    data: attachDelivery(input.data, input.delivery),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    inApp: input.inApp ?? true,
    channel: input.delivery.channels?.join(",") ?? "console",
    status: input.delivery.channels?.length === 0 ? "sent" : "pending",
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
  // A nonempty, unchanged unique value lets Prisma use the database upsert.
  // Catching a uniqueness error inside a PostgreSQL transaction aborts the fanout.
  return prisma.notification.upsert({
    where,
    create,
    update: { dedupeKey: input.dedupeKey },
    select: queueSelect,
  });
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
  queue: Pick<NotificationQueue, "enqueue">,
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
      subject: deriveNotificationSubject(message),
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
  audience?: NotificationAudience;
}

export function notificationDeliveryInput(
  orgId: string,
  senderId: string,
  recipient: NotificationRecipient,
  input: DirectNotificationInput,
): QueueNotificationInput | null {
  const type = input.type ?? "direct_notification";
  const message = input.message ?? input.text ?? input.subject;
  let inApp = input.inApp ?? true;
  let channels = input.channel
    ? input.channel
        .split(",")
        .map((channel) => channel.trim())
        .filter(Boolean)
    : undefined;
  if (recipient.id !== senderId) {
    const preferred = applyRecipientPreferences(
      recipient.notificationPreferences,
      type,
      { inApp, channels },
    );
    if (preferred.muted) return null;
    ({ inApp, channels } = preferred);
  }
  return {
    orgId,
    userId: recipient.id,
    createdByUserId: senderId,
    type,
    message,
    ...(input.data ? { data: input.data } : {}),
    inApp,
    dedupeKey: input.dedupeKey,
    delivery: {
      ...normalizeNotificationMessage({
        to: recipient.email,
        subject: input.subject,
        text: input.text ?? message,
        ...(input.html ? { html: input.html } : {}),
      }),
      ...(channels ? { channels } : {}),
    },
  };
}

export async function queueNotifications(
  prisma: PrismaClient,
  queue: Pick<NotificationQueue, "enqueue">,
  orgId: string,
  senderId: string,
  input: DirectNotificationInput,
) {
  const { recipients } = await resolveNotificationAudience(
    prisma,
    orgId,
    senderId,
    input.audience,
  );
  // Caller keys are scoped to the sender so they cannot collide with system keys.
  const dedupeKey = input.dedupeKey
    ? JSON.stringify(["direct", senderId, input.dedupeKey])
    : undefined;
  const ids = await prisma.$transaction(
    async (transaction) => {
      const queued: string[] = [];
      for (const recipient of recipients) {
        const delivery = notificationDeliveryInput(orgId, senderId, recipient, {
          ...input,
          dedupeKey,
        });
        if (delivery) queued.push(await queue.enqueue(delivery, transaction));
      }
      return queued;
    },
    { timeout: 30_000 },
  );
  return {
    // A single delivery keeps the original one-ID response; fanouts use ids.
    id: ids.length === 1 ? ids[0]! : null,
    ids,
    recipient_count: recipients.length,
    queued_count: ids.length,
    skipped_count: recipients.length - ids.length,
  };
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
      createdByUserId: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    message: row.message,
    data: stripInternalData(row.data),
    read: row.read,
    created_by: row.createdByUserId ?? null,
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

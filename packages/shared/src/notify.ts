import { z } from "zod";
import {
  idempotencyKeySchema,
  payloadSchema,
  type AutomationResponse,
} from "./automation";
import { notificationAudienceSchema } from "./notification-audience";
import { scheduleTimingSchema } from "./schedules";
import type { NotificationSchedule } from "./types";

export const notifySchema = z.strictObject({
  audience: notificationAudienceSchema.optional(),
  subject: z.string().trim().min(1).max(998),
  message: z.string().min(1).max(65536).optional(),
  type: z.string().min(1).max(128).optional(),
  data: payloadSchema.optional(),
  timing: scheduleTimingSchema.optional(),
  dedupe_key: idempotencyKeySchema.optional(),
});
export type NotifyInput = z.infer<typeof notifySchema>;
export type NotifyResult =
  | {
      kind: "immediate";
      id: string | null;
      ids: string[];
      recipient_count: number;
      queued_count: number;
      skipped_count: number;
    }
  | { kind: "scheduled"; schedule: NotificationSchedule };
export type NotifyResponse = AutomationResponse<NotifyResult>;

import {
  collectionValidationsSchema,
  notificationAudienceSchema,
  portableAutomationShape,
} from "@lastsaas/shared";
import { z } from "zod";
import { policyOptionsSchema } from "./policy-options";

const dateString = z.iso.datetime();
const collectionSchema = z.record(z.string(), z.unknown());
const recordSchema = z
  .object({
    id: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
    created_by: z.string(),
    created_at: dateString,
    updated_at: dateString,
  })
  .strict();
export const portableDataSchema = z
  .object({
    status: z.literal("ok").optional(),
    version: z.literal(1),
    ...portableAutomationShape,
    collections: z.array(
      z
        .object({
          name: z.string().min(1),
          schema: collectionSchema,
          description: z.string(),
          validations: collectionValidationsSchema.optional(),
          records: z.array(recordSchema),
        })
        .strict(),
    ),
    files: z.array(
      z
        .object({
          id: z.string().min(1),
          path: z.string().min(1),
          filename: z.string().min(1),
          mime_type: z.string().nullable(),
          size_bytes: z.number().int().nonnegative().nullable(),
          collection: z.string().nullable(),
          record_id: z.string().nullable(),
          uploaded_by: z.string(),
          created_at: dateString,
          updated_at: dateString,
        })
        .strict(),
    ),
    policies: z.array(
      z
        .object({
          subject: z.string().min(1),
          resource: z.string().min(1),
          action: z.string().min(1),
          ...policyOptionsSchema,
        })
        .strict(),
    ),
    role_assignments: z.array(
      z
        .object({ user_id: z.string().min(1), role: z.string().min(1) })
        .strict(),
    ),
    notification_schedules: z.array(
      z
        .object({
          id: z.string().min(1),
          user_id: z.string().min(1),
          audience: notificationAudienceSchema,
          dedupe_key: z.string().min(1),
          type: z.string().min(1),
          subject: z.string().min(1),
          message: z.string(),
          data: z.record(z.string(), z.unknown()).nullable(),
          deliver_at: dateString.nullable(),
          recurrence: z.string().nullable(),
          next_occurrence_at: dateString.nullable(),
          status: z.string().min(1),
          last_enqueued_at: dateString.nullable(),
          created_at: dateString,
          updated_at: dateString,
        })
        .strict(),
    ),
  })
  .strict();

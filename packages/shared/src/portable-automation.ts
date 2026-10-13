import { z } from "zod";
import {
  automationIdSchema as id,
  utcTimestampSchema as date,
  dynamicSchemaSchema,
  payloadSchema,
  resourceNameSchema,
} from "./automation";
import { queuePolicyShape } from "./queue";
import { scheduleTimingSchema } from "./schedules";
import { triggerCreateSchema } from "./triggers";

const timestamps = { created_at: date, updated_at: date };
// Backup DTOs omit organization IDs and all lease credentials. References use
// exported IDs and are remapped together by the importer.
export const portableAutomationShape = {
  queues: z
    .array(
      z.strictObject({
        id,
        name: resourceNameSchema,
        schema: dynamicSchemaSchema,
        schema_version: z.number().int().positive(),
        enabled: z.boolean(),
        ...queuePolicyShape,
        ...timestamps,
      }),
    )
    .optional(),
  queue_schedules: z
    .array(
      z.strictObject({
        id,
        queue_id: id,
        created_by: id,
        payload: payloadSchema,
        timing: scheduleTimingSchema,
        status: z.enum(["active", "paused", "completed"]),
        pause_reason: z.string().nullable(),
        ...timestamps,
      }),
    )
    .optional(),
  collection_triggers: z
    .array(
      z.strictObject({
        id,
        queue_id: id,
        created_by: id,
        configuration: triggerCreateSchema,
        status: z.enum(["active", "paused"]),
        pause_reason: z.string().nullable(),
        ...timestamps,
      }),
    )
    .optional(),
};
export type PortableAutomationData = z.infer<
  z.ZodObject<typeof portableAutomationShape>
>;

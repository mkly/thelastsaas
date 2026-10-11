import type { AutomationResponse } from "./automation";
import { z } from "zod";
import {
  automationIdSchema,
  nonemptyPatch,
  payloadSchema,
  resourceNameSchema,
  utcTimestampSchema,
  type AutomationContext,
  type AutomationPage,
  type JsonObject,
  type PageRequest,
} from "./automation";
import { recurrenceValueSchema } from "./validation";

export const scheduleTimingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), at: utcTimestampSchema }),
  z.strictObject({
    kind: z.literal("recurring"),
    recurrence: recurrenceValueSchema,
  }),
]);
export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>;
export const scheduleCreateSchema = z.strictObject({
  queue: resourceNameSchema,
  payload: payloadSchema,
  timing: scheduleTimingSchema,
  enabled: z.boolean().default(true),
});
export const scheduleUpdateSchema = z
  .strictObject({
    queue: resourceNameSchema.optional(),
    payload: payloadSchema.optional(),
    timing: scheduleTimingSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(nonemptyPatch, "At least one change is required");
export const scheduleIdSchema = automationIdSchema;
export type ScheduleCreate = z.infer<typeof scheduleCreateSchema>;
export type ScheduleUpdate = z.infer<typeof scheduleUpdateSchema>;
export interface QueueSchedule {
  id: string;
  organization_id: string;
  created_by: string;
  queue_id: string;
  queue: string;
  payload: JsonObject;
  timing: ScheduleTiming;
  timezone: string | null;
  status: "active" | "paused" | "completed";
  pause_reason: string | null;
  cursor_at: string | null;
  next_occurrence_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ScheduleOccurrence {
  id: string;
  schedule_id: string;
  occurrence_at: string;
  entry_id: string;
  created_at: string;
}
export interface MaterializeResult {
  enqueued: number;
  paused: number;
  has_more: boolean;
}
export interface ScheduleService {
  create(
    context: AutomationContext,
    input: ScheduleCreate,
  ): Promise<QueueSchedule>;
  list(
    context: AutomationContext,
    input: PageRequest,
  ): Promise<AutomationPage<QueueSchedule>>;
  show(context: AutomationContext, id: string): Promise<QueueSchedule>;
  update(
    context: AutomationContext,
    id: string,
    input: ScheduleUpdate,
  ): Promise<QueueSchedule>;
  delete(context: AutomationContext, id: string): Promise<void>;
}
/** Internal orchestration only; validates creator authority for each occurrence. */
export interface ScheduleMaterializer<UnitOfWork> {
  materialize(now: string): Promise<MaterializeResult>;
  materializeOccurrence(
    unitOfWork: UnitOfWork,
    scheduleId: string,
    occurrenceAt: string,
  ): Promise<ScheduleOccurrence>;
}

export type ScheduleResponse = AutomationResponse<{ schedule: QueueSchedule }>;

export type ScheduleListResponse = AutomationResponse<
  AutomationPage<QueueSchedule>
>;

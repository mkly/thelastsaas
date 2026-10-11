import type { AutomationResponse } from "./automation";
import { z } from "zod";
import {
  automationIdSchema,
  collectionNameSchema,
  fieldNameSchema,
  jsonValueSchema,
  nonemptyPatch,
  resourceNameSchema,
  type AutomationContext,
  type AutomationPage,
  type JsonObject,
  type PageRequest,
} from "./automation";
import { whereSchema } from "./where";

export const triggerEventSchema = z.enum(["create", "update", "delete"]);
export type TriggerEvent = z.infer<typeof triggerEventSchema>;
export const triggerMappingValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), value: jsonValueSchema }),
  z.strictObject({ kind: z.literal("before"), field: fieldNameSchema }),
  z.strictObject({ kind: z.literal("after"), field: fieldNameSchema }),
  z.strictObject({
    kind: z.literal("metadata"),
    key: z.enum(["recordId", "collectionName", "event", "occurredAt"]),
  }),
]);
export const triggerMappingSchema = z.record(
  fieldNameSchema,
  triggerMappingValueSchema,
);
const triggerFields = {
  collection: collectionNameSchema,
  queue: resourceNameSchema,
  events: z
    .array(triggerEventSchema)
    .min(1)
    .max(3)
    .refine(
      (value) => new Set(value).size === value.length,
      "Duplicate events",
    ),
  watched_fields: z
    .array(fieldNameSchema)
    .min(1)
    .max(512)
    .refine(
      (value) => new Set(value).size === value.length,
      "Duplicate watched fields",
    )
    .optional(),
  where: whereSchema.optional(),
  mapping: triggerMappingSchema,
  enabled: z.boolean(),
};
export const triggerCreateSchema = z
  .strictObject({
    ...triggerFields,
    enabled: triggerFields.enabled.default(true),
  })
  .superRefine((value, ctx) => {
    if (value.watched_fields && !value.events.includes("update"))
      ctx.addIssue({
        code: "custom",
        message: "Watched fields require an update event",
      });
    for (const [field, mapping] of Object.entries(value.mapping)) {
      if (
        (mapping.kind === "before" && value.events.includes("create")) ||
        (mapping.kind === "after" && value.events.includes("delete"))
      )
        ctx.addIssue({
          code: "custom",
          path: ["mapping", field],
          message: "Snapshot unavailable for a configured event",
        });
    }
  });
export const triggerUpdateSchema = z
  .strictObject(triggerFields)
  .partial()
  .refine(nonemptyPatch, "At least one change is required");
export const triggerIdSchema = automationIdSchema;
export type TriggerCreate = z.infer<typeof triggerCreateSchema>;
export type TriggerUpdate = z.infer<typeof triggerUpdateSchema>;
export type TriggerMapping = z.infer<typeof triggerMappingSchema>;
export interface CollectionTrigger {
  id: string;
  organization_id: string;
  created_by: string;
  collection_id: string;
  queue_id: string;
  collection: string;
  queue: string;
  events: TriggerEvent[];
  watched_fields: string[] | null;
  where: TriggerCreate["where"] | null;
  mapping: TriggerMapping;
  status: "active" | "paused";
  pause_reason: string | null;
  created_at: string;
  updated_at: string;
}
/** Snapshot stays internal and is projected before mapping; never a transport response. */
export interface RecordMutationEvent {
  mutation_id: string;
  record_id: string;
  collection: string;
  event: TriggerEvent;
  occurred_at: string;
  before: JsonObject | null;
  after: JsonObject | null;
  changed_fields: string[];
}
export interface TriggerService {
  create(
    context: AutomationContext,
    input: TriggerCreate,
  ): Promise<CollectionTrigger>;
  list(
    context: AutomationContext,
    input: PageRequest,
  ): Promise<AutomationPage<CollectionTrigger>>;
  show(context: AutomationContext, id: string): Promise<CollectionTrigger>;
  update(
    context: AutomationContext,
    id: string,
    input: TriggerUpdate,
  ): Promise<CollectionTrigger>;
  delete(context: AutomationContext, id: string): Promise<void>;
}
export interface TriggerPublisher<UnitOfWork> {
  publishInTransaction(
    unitOfWork: UnitOfWork,
    context: AutomationContext,
    event: RecordMutationEvent,
  ): Promise<{ enqueued: number; paused: number }>;
}

export type TriggerResponse = AutomationResponse<{
  trigger: CollectionTrigger;
}>;

export type TriggerListResponse = AutomationResponse<
  AutomationPage<CollectionTrigger>
>;

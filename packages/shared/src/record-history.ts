import { z } from "zod";
import {
  automationIdSchema,
  utcTimestampSchema,
  type JsonObject,
  type JsonValue,
} from "./automation";

export const recordHistoryQuerySchema = z
  .strictObject({
    record_id: automationIdSchema.optional(),
    change_set_id: automationIdSchema.optional(),
    since: utcTimestampSchema.optional(),
    until: utcTimestampSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .refine(
    (input) =>
      !input.since ||
      !input.until ||
      Date.parse(input.since) < Date.parse(input.until),
    {
      message: "since must be before until",
      path: ["until"],
    },
  );
export type RecordHistoryQuery = z.input<typeof recordHistoryQuerySchema>;

export interface RecordHistoryItem {
  id: string;
  record_id: string;
  operation: "create" | "update" | "delete";
  actor_id: string;
  change_set_id: string;
  created_at: string;
  /** Null denotes a nonexistent version; omitted denotes an unauthorized version. */
  before?: JsonObject | null;
  after?: JsonObject | null;
  changes: Record<string, { before?: JsonValue; after?: JsonValue }>;
}
export interface RecordHistoryResult {
  items: RecordHistoryItem[];
  next_cursor: string | null;
}

import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_LIMITS,
  AutomationConflictError,
  AutomationNotFoundError,
  AutomationUnavailableError,
  ackRequestSchema,
  claimRequestSchema,
  jobActionSchema,
  enqueueRequestSchema,
  extendRequestSchema,
  jsonByteLength,
  nackRequestSchema,
  pageRequestSchema,
  queueCreateSchema,
  queuePayloadSchema,
  queueUpdateSchema,
  scheduleCreateSchema,
  scheduleUpdateSchema,
  secretCreateSchema,
  secretReplaceSchema,
  secretRevealSchema,
  secretRotationSchema,
  secretKeyringConfigSchema,
  transactionOperationSchema,
  transactionRequestSchema,
  triggerCreateSchema,
  triggerMappingValueSchema,
  triggerUpdateSchema,
  whereSchema,
} from "./index";

const queue = { name: "jobs", schema: { title: "string", count: "integer" } };
const trigger = {
  collection: "tickets",
  queue: "jobs",
  events: ["update"],
  watched_fields: ["title"],
  where: { title: { contains: "urgent" } },
  mapping: { title: { kind: "after", field: "title" } },
};
const recurrence =
  "DTSTART;TZID=America/Los_Angeles:20261010T090000\nRRULE:FREQ=DAILY";

describe("automation request contracts", () => {
  test("exports interfaces' validators through the shared entry point", () => {
    expect(queueCreateSchema.parse(queue).enabled).toBe(true);
    expect(queueCreateSchema.parse({ ...queue })).toEqual({
      ...queue,
      enabled: true,
      max_attempts: 3,
      retry_delay_seconds: 30,
      lease_seconds: 60,
      retention_days: 7,
    });
    expect(claimRequestSchema.parse({})).toEqual({ limit: 1 });
    expect(pageRequestSchema.parse({})).toEqual({ limit: 100 });
    expect(triggerUpdateSchema.parse({ queue: "jobs2" })).toEqual({
      queue: "jobs2",
    });
  });

  test("preserves selectors for existing collection names", () => {
    expect(
      triggerCreateSchema.safeParse({
        ...trigger,
        collection: "old-collection",
      }).success,
    ).toBe(true);
    expect(
      transactionOperationSchema.safeParse({
        op: "record.delete",
        collection: "old-collection",
        id: "existing",
      }).success,
    ).toBe(true);
  });

  test("rejects unknown control fields, including proposed system bypasses", () => {
    const cases = [
      [queueCreateSchema, { ...queue, system: true }],
      [queueCreateSchema, { ...queue, where: {} }],
      [enqueueRequestSchema, { entries: [{ payload: {}, bypass: true }] }],
      [claimRequestSchema, { owner: "other" }],
      [ackRequestSchema, { token: "secret", user_id: "other" }],
      [nackRequestSchema, { token: "secret", payload: {} }],
      [
        extendRequestSchema,
        { token: "secret", lease_seconds: 1, expired: false },
      ],
      [jobActionSchema, { token: "secret" }],
      [
        scheduleCreateSchema,
        {
          queue: "jobs",
          payload: {},
          timing: { kind: "once", at: "2026-10-10T12:00:00Z", recurrence },
        },
      ],
      [triggerCreateSchema, { ...trigger, code: "execute()" }],
      [
        secretCreateSchema,
        { name: "credential", value: "x", key_version: "v1" },
      ],
      [secretRevealSchema, { value: "x" }],
      [
        transactionRequestSchema,
        {
          operations: [
            { op: "queue.enqueue", queue: "jobs", entry: { payload: {} } },
          ],
          sql: "DELETE",
        },
      ],
    ] as const;
    for (const [schema, input] of cases)
      expect(schema.safeParse(input).success).toBe(false);
  });

  test("rejects illegal resource and schema names and unsupported field definitions", () => {
    for (const name of [
      "1jobs",
      "jobs/tasks",
      "*",
      "jobs*",
      "jobs-with-dash",
      "",
      "a".repeat(65),
    ])
      expect(queueCreateSchema.safeParse({ ...queue, name }).success).toBe(
        false,
      );
    for (const schema of [
      {},
      { _private: "string" },
      { value: "code" },
      { value: { type: "string", required: true } },
    ])
      expect(queueCreateSchema.safeParse({ ...queue, schema }).success).toBe(
        false,
      );
    expect(
      queueCreateSchema.safeParse({
        name: "jobs",
        schema: {
          status: "enum:open,closed",
          ref: "ref:tickets",
          data: "json",
          recurrence: "recurrence",
        },
      }).success,
    ).toBe(true);
  });

  test("rejects unknown payload fields including legacy underscore metadata", () => {
    const schema = queuePayloadSchema(queue.schema);
    expect(schema.safeParse({ title: "ok", count: 1 }).success).toBe(true);
    expect(schema.safeParse({ count: 1.2 }).success).toBe(false);
    expect(schema.safeParse({ hidden: true }).success).toBe(false);
    expect(schema.safeParse({ _metadata: true }).success).toBe(false);
    // Existing field definitions have no required modifier; missing/null is allowed.
    expect(schema.safeParse({ title: null }).success).toBe(true);
  });

  test("counts UTF-8 bytes for queue payloads and secrets", () => {
    const overhead = jsonByteLength({ title: "" });
    expect(
      enqueueRequestSchema.safeParse({
        entries: [
          {
            payload: {
              title: "a".repeat(AUTOMATION_LIMITS.payloadBytes - overhead),
            },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      enqueueRequestSchema.safeParse({
        entries: [
          {
            payload: {
              title: "a".repeat(AUTOMATION_LIMITS.payloadBytes - overhead + 1),
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      enqueueRequestSchema.safeParse({
        entries: [{ payload: { title: "é".repeat(32768) } }],
      }).success,
    ).toBe(false);
    expect(
      secretReplaceSchema.safeParse({ value: "é".repeat(32768) }).success,
    ).toBe(true);
    expect(
      secretReplaceSchema.safeParse({ value: "é".repeat(32769) }).success,
    ).toBe(false);
    expect(
      enqueueRequestSchema.safeParse({
        entries: [{ payload: { value: undefined } }],
      }).success,
    ).toBe(false);
  });

  test("enforces all batch, lease, retry, retention and pagination boundaries", () => {
    expect(
      enqueueRequestSchema.safeParse({
        entries: Array.from({ length: 100 }, () => ({ payload: {} })),
      }).success,
    ).toBe(true);
    for (const entries of [
      [],
      Array.from({ length: 101 }, () => ({ payload: {} })),
    ])
      expect(enqueueRequestSchema.safeParse({ entries }).success).toBe(false);
    for (const limit of [0, 101, 1.5]) {
      expect(claimRequestSchema.safeParse({ limit }).success).toBe(false);
      expect(pageRequestSchema.safeParse({ limit }).success).toBe(false);
    }
    for (const lease_seconds of [0, 3601, 1.5]) {
      expect(
        queueCreateSchema.safeParse({ ...queue, lease_seconds }).success,
      ).toBe(false);
      expect(
        extendRequestSchema.safeParse({ token: "t", lease_seconds }).success,
      ).toBe(false);
    }
    expect(
      queueCreateSchema.safeParse({
        ...queue,
        max_attempts: 100,
        retention_days: 365,
        lease_seconds: 3600,
      }).success,
    ).toBe(true);
    for (const input of [
      { max_attempts: 0 },
      { max_attempts: 101 },
      { retention_days: 0 },
      { retention_days: 366 },
    ])
      expect(queueCreateSchema.safeParse({ ...queue, ...input }).success).toBe(
        false,
      );
    expect(
      nackRequestSchema.safeParse({ token: "t", error: "delivery failed" })
        .success,
    ).toBe(true);
    expect(ackRequestSchema.safeParse({ token: "" }).success).toBe(false);
  });

  test("requires one supported schedule timing and an explicit UTC instant", () => {
    const base = { queue: "jobs", payload: {} };
    expect(
      scheduleCreateSchema.safeParse({
        ...base,
        timing: { kind: "recurring", recurrence },
      }).success,
    ).toBe(true);
    expect(
      scheduleCreateSchema.safeParse({
        ...base,
        timing: { kind: "once", at: "2026-10-10T12:00:00Z" },
      }).success,
    ).toBe(true);
    for (const timing of [
      { kind: "once" },
      { kind: "other", recurrence },
      { kind: "recurring", recurrence: "RRULE:FREQ=DAILY" },
      { kind: "once", at: "2026-10-10T12:00:00" },
      { kind: "once", at: "2026-10-10T12:00:00-07:00" },
    ])
      expect(scheduleCreateSchema.safeParse({ ...base, timing }).success).toBe(
        false,
      );
  });

  test("restricts trigger mapping to explicit tagged values and valid snapshots", () => {
    expect(triggerCreateSchema.safeParse(trigger).success).toBe(true);
    for (const mapping of [
      { kind: "secret", name: "credential" },
      { kind: "after", field: "bad.name" },
      { kind: "metadata", key: "token" },
      { kind: "literal", value: 1, code: "x" },
    ])
      expect(triggerMappingValueSchema.safeParse(mapping).success).toBe(false);
    expect(
      triggerMappingValueSchema.safeParse({
        kind: "literal",
        value: { nested: [1, null, "x"] },
      }).success,
    ).toBe(true);
    expect(
      triggerCreateSchema.safeParse({ ...trigger, events: ["create"] }).success,
    ).toBe(false);
    expect(
      triggerCreateSchema.safeParse({
        ...trigger,
        events: ["update", "update"],
      }).success,
    ).toBe(false);
    expect(
      triggerCreateSchema.safeParse({ ...trigger, events: ["delete"] }).success,
    ).toBe(false);
    expect(
      triggerCreateSchema.safeParse({ ...trigger, watched_fields: [] }).success,
    ).toBe(false);
  });

  test("uses the existing bounded Where grammar with no unknown operators", () => {
    expect(
      whereSchema.safeParse({
        and: [{ title: { contains: "urgent" } }, { not: { count: { lt: 1 } } }],
      }).success,
    ).toBe(true);
    for (const where of [
      { and: [] },
      { and: [{}], or: [{}] },
      { title: { script: "x" } },
    ])
      expect(triggerCreateSchema.safeParse({ ...trigger, where }).success).toBe(
        false,
      );
    let where: unknown = { title: "x" };
    for (let i = 0; i < 9; i++) where = { not: where };
    expect(whereSchema.safeParse(where).success).toBe(false);
  });

  test("rejects empty patches and bounded rotation violations", () => {
    for (const schema of [
      queueUpdateSchema,
      scheduleUpdateSchema,
      triggerUpdateSchema,
    ])
      expect(schema.safeParse({}).success).toBe(false);
    expect(secretRotationSchema.parse({ key_version: "v2" }).limit).toBe(100);
    expect(
      secretRotationSchema.safeParse({ key_version: "v2", limit: 101 }).success,
    ).toBe(false);
    expect(
      secretRotationSchema.safeParse({ key_version: "../v2" }).success,
    ).toBe(false);
  });

  test("accepts literal operations and rejects arbitrary or interpolated operation shapes", () => {
    const operations = [
      { op: "record.create", collection: "tickets", data: { title: "new" } },
      {
        op: "record.update",
        collection: "tickets",
        id: "record-id",
        data: { title: "changed" },
      },
      { op: "record.delete", collection: "tickets", id: "record-id" },
      { op: "queue.enqueue", queue: "jobs", entry: { payload: {} } },
    ];
    expect(
      transactionRequestSchema.safeParse({
        operations,
        idempotency_key: "request",
      }).success,
    ).toBe(true);
    for (const input of [
      { op: "sql", query: "DELETE" },
      { op: "record.update", collection: "tickets", data: {} },
      { op: "record.delete", collection: "tickets", id: { from_result: 0 } },
      {
        op: "queue.enqueue",
        queue: "jobs",
        entry: { payload: {} },
        result_ref: 0,
      },
    ])
      expect(transactionOperationSchema.safeParse(input).success).toBe(false);
    expect(transactionRequestSchema.safeParse({ operations: [] }).success).toBe(
      false,
    );
    expect(
      transactionRequestSchema.safeParse({
        operations: Array(26).fill(operations[2]),
      }).success,
    ).toBe(false);
    expect(
      transactionRequestSchema.safeParse({
        operations: [
          {
            op: "record.create",
            collection: "tickets",
            data: { title: "é".repeat(524288) },
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("validates keyring configuration without an ephemeral key fallback", () => {
    const key = btoa("a".repeat(32));
    expect(
      secretKeyringConfigSchema.safeParse({
        active_version: "v1",
        keys: { v1: key },
      }).success,
    ).toBe(true);
    for (const input of [
      { active_version: "v2", keys: { v1: key } },
      { active_version: "v1", keys: { v1: btoa("a".repeat(31)) } },
      { active_version: "v1", keys: { v1: "malformed" } },
      { active_version: "v1", keys: { v1: key }, fallback: true },
    ])
      expect(secretKeyringConfigSchema.safeParse(input).success).toBe(false);
  });

  test("uses domain errors without reflecting foreign IDs or secret values", () => {
    expect(new AutomationNotFoundError().toResponse()).toEqual({
      status: "error",
      error: "AutomationNotFoundError",
      message: "Resource not found",
    });
    expect(new AutomationConflictError().code).toBe("AutomationConflictError");
    expect(new AutomationUnavailableError().code).toBe(
      "AutomationUnavailableError",
    );
  });
});

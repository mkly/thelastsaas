import { DateTime, IANAZone } from "luxon";
import { RRuleSet, rrulestr } from "rrule";

const BASIC_LOCAL_DATE_TIME = "yyyyLLdd'T'HHmmss";
const DTSTART_RE = /^DTSTART;TZID=([^:;\r\n]+):(\d{8}T\d{6})$/;
const RRULE_RE = /^RRULE:(.+)$/;
const EXDATE_RE = /^EXDATE(?:;TZID=([^:;\r\n]+))?:(.+)$/;

export const DEFAULT_RECURRENCE_LIMITS = {
  maxWindowDays: 732,
  maxOccurrencesPerRecord: 5_000,
  maxOccurrencesPerQuery: 10_000,
} as const;

export interface RecurrenceLimits {
  maxWindowDays: number;
  maxOccurrencesPerRecord: number;
  maxOccurrencesPerQuery: number;
}

export interface OccurrenceWindow {
  from: Date | string;
  to: Date | string;
}

export interface ParsedRecurrence {
  timezone: string;
  startsAt: Date;
  rule: RRuleSet;
}

export class InvalidRecurrenceError extends Error {
  readonly code = "INVALID_RECURRENCE";

  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid recurrence: ${message}`, options);
    this.name = "InvalidRecurrenceError";
  }
}

export class RecurrenceWindowLimitError extends Error {
  readonly code = "RECURRENCE_WINDOW_LIMIT";

  constructor(public readonly maxWindowDays: number) {
    super(`Recurrence window exceeds the ${maxWindowDays}-day limit`);
    this.name = "RecurrenceWindowLimitError";
  }
}

export class RecurrenceRecordLimitError extends Error {
  readonly code = "RECURRENCE_RECORD_LIMIT";

  constructor(public readonly maxOccurrences: number) {
    super(
      `Recurrence exceeds the per-record limit of ${maxOccurrences} occurrences`,
    );
    this.name = "RecurrenceRecordLimitError";
  }
}

export class RecurrenceQueryLimitError extends Error {
  readonly code = "RECURRENCE_QUERY_LIMIT";

  constructor(public readonly maxOccurrences: number) {
    super(
      `Recurrence query exceeds the limit of ${maxOccurrences} occurrences`,
    );
    this.name = "RecurrenceQueryLimitError";
  }
}

/**
 * Parse and deeply validate the recurrence field format used by collections.
 * The DTSTART TZID is kept on the rrule input so local wall-clock times remain
 * stable when an occurrence crosses a daylight-saving boundary.
 */
export function parseRecurrence(content: string): ParsedRecurrence {
  const lines = unfoldLines(content);
  if (lines.length < 2) {
    throw new InvalidRecurrenceError("expected DTSTART and RRULE lines");
  }

  const dtstartMatch = DTSTART_RE.exec(lines[0] ?? "");
  if (!dtstartMatch) {
    throw new InvalidRecurrenceError(
      "first line must be DTSTART;TZID=<zone>:<local date-time>",
    );
  }

  const timezone = dtstartMatch[1] ?? "";
  const localStart = dtstartMatch[2] ?? "";
  if (!IANAZone.isValidZone(timezone)) {
    throw new InvalidRecurrenceError(`unknown timezone '${timezone}'`);
  }

  const startsAt = parseLocalDateTime(localStart, timezone, "DTSTART");
  const rruleLines = lines.filter((line) => RRULE_RE.test(line));
  if (rruleLines.length !== 1 || lines[1] !== rruleLines[0]) {
    throw new InvalidRecurrenceError(
      "expected exactly one RRULE immediately after DTSTART",
    );
  }

  for (const line of lines.slice(2)) {
    validateExdate(line, timezone);
  }

  const normalized = lines
    .map((line, index) => (index < 2 ? line : normalizeExdate(line, timezone)))
    .join("\n");

  try {
    const parsed = rrulestr(normalized, { forceset: true });
    if (!(parsed instanceof RRuleSet)) {
      throw new Error("parser did not return a recurrence set");
    }
    return { timezone, startsAt: startsAt.toJSDate(), rule: parsed };
  } catch (error) {
    if (error instanceof InvalidRecurrenceError) throw error;
    const message =
      error instanceof Error ? error.message : "could not parse RRULE";
    throw new InvalidRecurrenceError(message, { cause: error });
  }
}

/** Validate recurrence content without expanding it. */
export function validateRecurrence(content: string): void {
  parseRecurrence(content);
}

/** Expand one recurrence field, including its EXDATE exclusions. */
export function expandRecurrence(
  content: string,
  window: OccurrenceWindow,
  options: Partial<RecurrenceLimits> = {},
): Date[] {
  const limits = resolveLimits(options);
  const normalizedWindow = validateWindow(window, limits.maxWindowDays);
  const parsed = parseRecurrence(content);
  return expandRule(parsed.rule, normalizedWindow, limits, 0).occurrences;
}

/**
 * Expand several record recurrence fields under one aggregate query budget.
 * Results retain the input order and contain an array of dates per record.
 */
export function expandRecurrences(
  contents: readonly string[],
  window: OccurrenceWindow,
  options: Partial<RecurrenceLimits> = {},
): Date[][] {
  const limits = resolveLimits(options);
  const normalizedWindow = validateWindow(window, limits.maxWindowDays);
  const results: Date[][] = [];
  let queryCount = 0;

  for (const content of contents) {
    const parsed = parseRecurrence(content);
    const expanded = expandRule(
      parsed.rule,
      normalizedWindow,
      limits,
      queryCount,
    );
    results.push(expanded.occurrences);
    queryCount = expanded.queryCount;
  }

  return results;
}

interface NormalizedWindow {
  from: Date;
  to: Date;
}

function unfoldLines(content: string): string[] {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new InvalidRecurrenceError("value must be a non-empty string");
  }

  return content
    .replaceAll("\r\n", "\n")
    .replace(/\n[ \t]/g, "")
    .trim()
    .split("\n");
}

function parseLocalDateTime(
  value: string,
  timezone: string,
  property: string,
): DateTime {
  const parsed = DateTime.fromFormat(value, BASIC_LOCAL_DATE_TIME, {
    zone: timezone,
    setZone: true,
  });
  if (!parsed.isValid || parsed.toFormat(BASIC_LOCAL_DATE_TIME) !== value) {
    throw new InvalidRecurrenceError(
      `${property} contains an invalid local date-time '${value}'`,
    );
  }
  return parsed;
}

function validateExdate(line: string, defaultTimezone: string): void {
  const match = EXDATE_RE.exec(line);
  if (!match) {
    throw new InvalidRecurrenceError("only EXDATE lines may follow RRULE");
  }

  const timezone = match[1] ?? defaultTimezone;
  if (!IANAZone.isValidZone(timezone)) {
    throw new InvalidRecurrenceError(`unknown EXDATE timezone '${timezone}'`);
  }

  const values = (match[2] ?? "").split(",");
  if (values.length === 0) {
    throw new InvalidRecurrenceError(
      "EXDATE must contain at least one date-time",
    );
  }
  for (const value of values) parseLocalDateTime(value, timezone, "EXDATE");
}

function normalizeExdate(line: string, defaultTimezone: string): string {
  const match = EXDATE_RE.exec(line);
  if (!match) return line;
  return match[1] ? line : `EXDATE;TZID=${defaultTimezone}:${match[2] ?? ""}`;
}

function resolveLimits(options: Partial<RecurrenceLimits>): RecurrenceLimits {
  const limits = { ...DEFAULT_RECURRENCE_LIMITS, ...options };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  return limits;
}

function validateWindow(
  window: OccurrenceWindow,
  maxWindowDays: number,
): NormalizedWindow {
  const from = toDateTime(window.from);
  const to = toDateTime(window.to);
  if (to < from)
    throw new InvalidRecurrenceError("window 'to' must not precede 'from'");
  if (to.toMillis() > from.plus({ days: maxWindowDays }).toMillis()) {
    throw new RecurrenceWindowLimitError(maxWindowDays);
  }
  return { from: from.toJSDate(), to: to.toJSDate() };
}

function toDateTime(value: Date | string): DateTime {
  const parsed =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone: "utc" })
      : DateTime.fromISO(value, { zone: "utc", setZone: true });
  if (!parsed.isValid)
    throw new InvalidRecurrenceError(`invalid window date '${String(value)}'`);
  return parsed.toUTC();
}

/**
 * Expand one rule within the window in a single pass. `between` with an
 * iterator stops as soon as a cap is hit; repeated `after()` calls would
 * restart iteration from DTSTART every time and turn expansion quadratic.
 */
function expandRule(
  rule: RRuleSet,
  window: NormalizedWindow,
  limits: RecurrenceLimits,
  initialQueryCount: number,
): { occurrences: Date[]; queryCount: number } {
  const queryBudget = Math.max(
    limits.maxOccurrencesPerQuery - initialQueryCount,
    0,
  );
  const cap = Math.min(limits.maxOccurrencesPerRecord, queryBudget);
  let capped = false;

  const occurrences = rule.between(window.from, window.to, true, (_, count) => {
    if (count >= cap) {
      capped = true;
      return false;
    }
    return true;
  });

  if (capped) {
    if (occurrences.length >= limits.maxOccurrencesPerRecord) {
      throw new RecurrenceRecordLimitError(limits.maxOccurrencesPerRecord);
    }
    throw new RecurrenceQueryLimitError(limits.maxOccurrencesPerQuery);
  }

  return { occurrences, queryCount: initialQueryCount + occurrences.length };
}

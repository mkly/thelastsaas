import { describe, expect, it } from "bun:test";

import {
  InvalidRecurrenceError,
  RecurrenceQueryLimitError,
  RecurrenceRecordLimitError,
  RecurrenceWindowLimitError,
  expandRecurrence,
  expandRecurrences,
  parseRecurrence,
} from "../src/lib/recurrence";

const weekly = [
  "DTSTART;TZID=America/New_York:20260301T090000",
  "RRULE:FREQ=WEEKLY;COUNT=4",
].join("\n");

describe("recurrence engine", () => {
  it("parses recurrence content and preserves local time over DST", () => {
    expect(parseRecurrence(weekly).timezone).toBe("America/New_York");
    expect(
      expandRecurrence(weekly, {
        from: "2026-03-01T00:00:00Z",
        to: "2026-03-30T00:00:00Z",
      }).map((date) => date.toISOString()),
    ).toEqual([
      "2026-03-01T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-15T13:00:00.000Z",
      "2026-03-22T13:00:00.000Z",
    ]);
  });

  it("honors EXDATE with explicit or inherited TZID", () => {
    const explicit = `${weekly}\nEXDATE;TZID=America/New_York:20260308T090000`;
    const inherited = `${weekly}\nEXDATE:20260308T090000`;
    const window = {
      from: "2026-03-01T00:00:00Z",
      to: "2026-03-30T00:00:00Z",
    };

    for (const recurrence of [explicit, inherited]) {
      expect(
        expandRecurrence(recurrence, window).map((date) => date.toISOString()),
      ).toEqual([
        "2026-03-01T14:00:00.000Z",
        "2026-03-15T13:00:00.000Z",
        "2026-03-22T13:00:00.000Z",
      ]);
    }
  });

  it("rejects malformed content and unknown timezones", () => {
    expect(() => parseRecurrence("RRULE:FREQ=DAILY")).toThrow(
      InvalidRecurrenceError,
    );
    expect(() =>
      parseRecurrence(
        "DTSTART;TZID=Not/A_Zone:20260301T090000\nRRULE:FREQ=DAILY",
      ),
    ).toThrow(InvalidRecurrenceError);
  });

  it("expands a two-year daily series in a single pass", () => {
    const daily = [
      "DTSTART;TZID=America/New_York:20260101T090000",
      "RRULE:FREQ=DAILY",
    ].join("\n");
    const started = performance.now();
    const occurrences = expandRecurrence(daily, {
      from: "2026-01-01T00:00:00Z",
      to: "2028-01-01T00:00:00Z",
    });

    expect(occurrences.length).toBe(730);
    expect(occurrences[0]?.toISOString()).toBe("2026-01-01T14:00:00.000Z");
    // the earlier after()-per-occurrence loop needed minutes for this window
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("uses distinct errors for window, record, and query caps", () => {
    const daily = "DTSTART;TZID=UTC:20260101T000000\nRRULE:FREQ=DAILY;COUNT=10";
    expect(() =>
      expandRecurrence(
        daily,
        { from: "2026-01-01T00:00:00Z", to: "2026-01-04T00:00:00Z" },
        {
          maxWindowDays: 2,
        },
      ),
    ).toThrow(RecurrenceWindowLimitError);
    expect(() =>
      expandRecurrence(
        daily,
        { from: "2026-01-01T00:00:00Z", to: "2026-01-04T00:00:00Z" },
        {
          maxOccurrencesPerRecord: 2,
        },
      ),
    ).toThrow(RecurrenceRecordLimitError);
    expect(() =>
      expandRecurrences(
        [daily, daily],
        {
          from: "2026-01-01T00:00:00Z",
          to: "2026-01-02T00:00:00Z",
        },
        { maxOccurrencesPerQuery: 3 },
      ),
    ).toThrow(RecurrenceQueryLimitError);
  });
});

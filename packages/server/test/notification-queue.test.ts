import { describe, expect, mock, test } from "bun:test";

import {
  deriveNotificationSubject,
  NOTIFICATION_SUBJECT_MAX_LENGTH,
  NotificationDispatcher,
  type NotificationChannel,
} from "../src/notifications/channels";
import {
  mergeNotificationPreferences,
  normalizeNotificationPreferences,
  resolveNotificationChannels,
} from "../src/notifications/preferences";

describe("notification email subjects", () => {
  test("uses a single-line message as the subject", () => {
    expect(deriveNotificationSubject("Build finished")).toBe("Build finished");
  });

  test("uses only the first line of a multi-line message", () => {
    expect(
      deriveNotificationSubject(
        "Build finished\nThe deployment is ready for review.",
      ),
    ).toBe("Build finished");
  });

  test("truncates an over-length first line to the subject limit", () => {
    const subject = deriveNotificationSubject("A".repeat(100));

    expect(subject).toBe(`${"A".repeat(79)}…`);
    expect(subject.length).toBe(NOTIFICATION_SUBJECT_MAX_LENGTH);
  });
});

describe("notification preferences", () => {
  test("normalizes defaults and retains only meaningful per-kind overrides", () => {
    expect(normalizeNotificationPreferences(null)).toEqual({
      default: { in_app: true, email: true },
      by_kind: {},
    });

    expect(
      mergeNotificationPreferences(null, {
        by_kind: { invitation: { email: false } },
      }),
    ).toEqual({
      default: { in_app: true, email: true },
      by_kind: { invitation: { in_app: true, email: false } },
    });
  });

  test("a default-only update applies to kinds without an explicit override", () => {
    const stored = mergeNotificationPreferences(null, {
      by_kind: { invitation: { email: false } },
    });

    const merged = mergeNotificationPreferences(stored, {
      default: { email: false },
    });

    expect(merged).toEqual({
      default: { in_app: true, email: false },
      by_kind: {},
    });
    expect(resolveNotificationChannels(merged, "role_assigned")).toEqual({
      in_app: true,
      email: false,
    });
  });

  test("keeps an explicit override that still differs from the new default", () => {
    const stored = mergeNotificationPreferences(null, {
      by_kind: { invitation: { in_app: false } },
    });

    expect(
      mergeNotificationPreferences(stored, { default: { email: false } }),
    ).toEqual({
      default: { in_app: true, email: false },
      by_kind: { invitation: { in_app: false, email: true } },
    });
  });
});

describe("notification delivery", () => {
  test("fans out to every configured channel", async () => {
    const consoleSend = mock().mockResolvedValue(true);
    const emailSend = mock().mockResolvedValue(true);
    const channels: NotificationChannel[] = [
      { name: "console", send: consoleSend },
      { name: "email", send: emailSend },
    ];
    const dispatcher = new NotificationDispatcher(channels);
    const delivered = await dispatcher.send({
      to: "recipient@example.com",
      subject: "Hello",
      text: "World",
    });

    expect(delivered).toBe(true);
    expect(consoleSend).toHaveBeenCalledTimes(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
  });
});

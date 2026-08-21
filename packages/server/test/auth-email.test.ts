import { describe, expect, test } from "bun:test";

import { createAuthEmailSender } from "../src/auth-email";
import { loadConfig } from "../src/config";
import {
  NotificationDispatcher,
  type NotificationChannel,
  type NotificationMessage,
} from "../src/notifications";

function recordingChannel(name: string, result = true) {
  const sent: NotificationMessage[] = [];
  const channel: NotificationChannel = {
    name,
    async send(message) {
      sent.push(message);
      return result;
    },
  };
  return { channel, sent };
}

describe("auth email sender", () => {
  test("sends over SMTP when it is configured", async () => {
    const email = recordingChannel("email");
    const console_ = recordingChannel("console");
    const dispatcher = new NotificationDispatcher([
      console_.channel,
      email.channel,
    ]);
    const config = loadConfig({ SMTP_HOST: "smtp.example.com" });

    await createAuthEmailSender(
      dispatcher,
      config,
    )({
      type: "magic-link",
      to: "user@example.com",
      url: "https://app.example.com/magic?token=abc",
    });

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toBe("user@example.com");
    expect(email.sent[0]!.subject).toBe("Sign in to The Last SaaS");
    expect(email.sent[0]!.text).toContain(
      "https://app.example.com/magic?token=abc",
    );
    // SMTP delivery should not also spam the logs with the sign-in link.
    expect(console_.sent).toHaveLength(0);
  });

  test("falls back to the console channel without SMTP", async () => {
    const console_ = recordingChannel("console");
    const dispatcher = new NotificationDispatcher([console_.channel]);
    const config = loadConfig({});

    await createAuthEmailSender(
      dispatcher,
      config,
    )({
      type: "invitation",
      to: "invitee@example.com",
      url: "https://app.example.com/auth/invitations/1",
    });

    expect(console_.sent).toHaveLength(1);
    expect(console_.sent[0]!.subject).toBe(
      "You have been invited to a Last SaaS organization",
    );
  });

  test("surfaces a delivery failure to Better Auth", async () => {
    const email = recordingChannel("email", false);
    const dispatcher = new NotificationDispatcher([email.channel]);
    const config = loadConfig({ SMTP_HOST: "smtp.example.com" });

    await expect(
      createAuthEmailSender(
        dispatcher,
        config,
      )({
        type: "password-reset",
        to: "user@example.com",
        url: "https://app.example.com/reset",
      }),
    ).rejects.toThrow("Failed to send password-reset email");
  });
});

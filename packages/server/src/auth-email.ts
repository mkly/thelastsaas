import type { AuthEmail, AuthEmailSender } from "./auth";
import type { AppConfig } from "./config";
import { log } from "./logger";
import type { NotificationDispatcher } from "./notifications";

const TEMPLATES: Record<
  AuthEmail["type"],
  { subject: string; body: (url: string) => string }
> = {
  "magic-link": {
    subject: "Sign in to The Last SaaS",
    body: (url) =>
      `Use the link below to sign in. It expires shortly and can only be used once.\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
  },
  "password-reset": {
    subject: "Reset your Last SaaS password",
    body: (url) =>
      `Use the link below to choose a new password.\n\n${url}\n\nIf you did not request this, your password is unchanged and you can ignore this email.`,
  },
  "email-verification": {
    subject: "Verify your email address",
    body: (url) =>
      `Confirm this address to finish setting up your Last SaaS account.\n\n${url}`,
  },
  invitation: {
    subject: "You have been invited to a Last SaaS organization",
    body: (url) =>
      `Accept the invitation using the link below.\n\n${url}\n\nIf you did not expect this invitation, you can ignore this email.`,
  },
};

/**
 * Routes Better Auth's transactional email through the notification
 * dispatcher, so magic links and invitations use SMTP wherever it is
 * configured instead of only reaching the logs.
 */
export function createAuthEmailSender(
  notifications: NotificationDispatcher,
  config: AppConfig,
): AuthEmailSender {
  // Console is the only channel registered without SMTP, and requesting a
  // channel the dispatcher does not know reports failure rather than falling
  // back to it.
  const channels = config.smtpHost ? ["email"] : ["console"];

  return async ({ type, to, url }) => {
    const template = TEMPLATES[type];
    log.info("auth-email", `sending ${type} email to ${to} via ${channels[0]}`);
    const delivered = await notifications.send(
      { to, subject: template.subject, text: template.body(url) },
      channels,
    );
    if (!delivered) {
      log.error("auth-email", `failed to send ${type} email to ${to}`);
      throw new Error(`Failed to send ${type} email to ${to}`);
    }
  };
}

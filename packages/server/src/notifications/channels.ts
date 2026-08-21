import nodemailer, { type Transporter } from "nodemailer";

import { log } from "../logger";

export interface NotificationMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface NotificationChannel {
  readonly name: string;
  send(message: NotificationMessage): Promise<boolean>;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export function normalizeNotificationMessage(
  message: NotificationMessage,
): NotificationMessage {
  const subject = message.subject
    .replace(/[\r\n]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  const html =
    message.html ??
    message.text
      .trim()
      .split(/\n{2,}/)
      .map(
        (paragraph) =>
          `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, "<br />")}</p>`,
      )
      .join("\n");

  return {
    ...message,
    subject,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body>${html}</body></html>`,
  };
}

export class ConsoleChannel implements NotificationChannel {
  readonly name = "console";

  async send(message: NotificationMessage): Promise<boolean> {
    log.info(
      "notifications",
      `console delivery to ${message.to} | ${message.subject}`,
    );
    if (process.env.NODE_ENV !== "production") {
      log.info("notifications", message.text);
    }
    return true;
  }
}

export interface EmailChannelOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export class EmailChannel implements NotificationChannel {
  readonly name = "email";
  private readonly transporter: Transporter;

  constructor(private readonly options: EmailChannelOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      ...(options.user
        ? { auth: { user: options.user, pass: options.pass } }
        : {}),
    });
  }

  async send(message: NotificationMessage): Promise<boolean> {
    const normalized = normalizeNotificationMessage(message);
    const info = await this.transporter.sendMail({
      from: this.options.from,
      to: normalized.to,
      subject: normalized.subject,
      text: normalized.text,
      html: normalized.html,
    });
    log.info(
      "notifications",
      `email sent to ${normalized.to} (${normalized.subject}) id=${info.messageId}`,
    );
    return true;
  }

  /* Opens a connection and authenticates without sending anything, so a bad
     host or credential surfaces at startup instead of on the first send. */
  async verify(): Promise<void> {
    const target = `${this.options.host}:${this.options.port}`;
    try {
      await this.transporter.verify();
      log.info("notifications", `SMTP connection to ${target} verified`);
    } catch (error) {
      log.error(
        "notifications",
        `SMTP verification failed for ${target}`,
        error,
      );
    }
  }
}

export class NotificationDispatcher {
  private readonly channels: Map<string, NotificationChannel>;

  constructor(channels: NotificationChannel[]) {
    this.channels = new Map(channels.map((channel) => [channel.name, channel]));
  }

  hasChannel(name: string): boolean {
    return this.channels.has(name);
  }

  async send(
    message: NotificationMessage,
    requestedChannels?: readonly string[],
  ): Promise<boolean> {
    const channels = requestedChannels?.length
      ? requestedChannels.map((name) => this.channels.get(name))
      : [...this.channels.values()];

    if (channels.length === 0 || channels.some((channel) => !channel)) {
      log.error(
        "notifications",
        `no usable channel for ${message.to}: requested [${
          requestedChannels?.join(", ") ?? ""
        }], registered [${[...this.channels.keys()].join(", ")}]`,
      );
      return false;
    }

    const results = await Promise.allSettled(
      channels.map((channel) => channel!.send(message)),
    );
    let delivered = true;
    for (const [index, result] of results.entries()) {
      const name = channels[index]!.name;
      if (result.status === "rejected") {
        delivered = false;
        log.error(
          "notifications",
          `${name} channel failed for ${message.to} (${message.subject})`,
          result.reason,
        );
      } else if (!result.value) {
        delivered = false;
        log.error(
          "notifications",
          `${name} channel reported failure for ${message.to} (${message.subject})`,
        );
      }
    }
    return delivered;
  }
}

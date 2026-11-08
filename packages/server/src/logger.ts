import pino from "pino";

// Pino writes JSON lines to stdout unless a file path is configured.
export const log = pino(
  { level: process.env.LOG_LEVEL || "info" },
  process.env.LOG_FILE ? pino.destination(process.env.LOG_FILE) : undefined,
);

/**
 * Minimal leveled logger for journald-backed deployments.
 *
 * When stdout/stderr are connected to the journal (systemd sets
 * JOURNAL_STREAM), each line is prefixed with an sd-daemon priority tag
 * (`<3>` = err, `<6>` = info, ...) that journald parses into the entry's
 * PRIORITY field, so `journalctl -u lastsaas -p err` and friends work.
 * Outside systemd the prefix is omitted and lines stay human-readable.
 *
 * LOG_LEVEL (debug | info | warn | error, default info) sets the threshold.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/* syslog priorities: DEBUG=7, INFO=6, WARNING=4, ERR=3 */
const SYSLOG_PRIORITY: Record<LogLevel, number> = {
  debug: 7,
  info: 6,
  warn: 4,
  error: 3,
};

function resolveThreshold(): number {
  const configured = process.env.LOG_LEVEL as LogLevel | undefined;
  return (configured && LEVEL_RANK[configured]) || LEVEL_RANK.info;
}

const threshold = resolveThreshold();
const underJournald = Boolean(process.env.JOURNAL_STREAM);

function write(
  level: LogLevel,
  scope: string,
  message: string,
  detail?: unknown,
): void {
  if (LEVEL_RANK[level] < threshold) return;
  const prefix = underJournald ? `<${SYSLOG_PRIORITY[level]}>` : "";
  const line = `${prefix}[${scope}] ${message}`;
  const emit = LEVEL_RANK[level] >= LEVEL_RANK.warn
    ? console.error
    : console.log;
  if (detail === undefined) emit(line);
  else emit(line, detail);
}

export const log = {
  debug: (scope: string, message: string, detail?: unknown) =>
    write("debug", scope, message, detail),
  info: (scope: string, message: string, detail?: unknown) =>
    write("info", scope, message, detail),
  warn: (scope: string, message: string, detail?: unknown) =>
    write("warn", scope, message, detail),
  error: (scope: string, message: string, detail?: unknown) =>
    write("error", scope, message, detail),
};

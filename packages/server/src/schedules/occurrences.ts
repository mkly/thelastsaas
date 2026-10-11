import { Prisma } from "@prisma/client";
import { parseRecurrence } from "../lib/recurrence";
import { executeStatement, queryRows, sql } from "../db/query/kysely";
import type { UnitOfWork } from "../db/unit-of-work";

/** Acquire before reading a cursor or its authority; always lock producers before
 * destination queues. SQLite obtains the writer lock before transaction reads. */
export async function lockOccurrenceSource(
  unit: UnitOfWork,
  source: "queue_schedules" | "notification_schedules",
  id: string,
) {
  const table = sql.table(source);
  if (unit.provider === "postgresql")
    await queryRows(
      unit.db,
      unit.provider,
      sql`SELECT id FROM ${table} WHERE id = ${id} FOR UPDATE`,
    );
  else
    await executeStatement(
      unit.db,
      unit.provider,
      sql`UPDATE ${table} SET status = status WHERE id = ${id}`,
    );
}

export function nextScheduleOccurrence(recurrence: string, cursor: Date) {
  return parseRecurrence(recurrence).rule.after(cursor, false);
}

export async function retryScheduleContention<T>(
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const retry =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" ||
          error.code === "P1008" ||
          (error.code === "P2010" &&
            ["5", "517", "SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"].includes(
              String(error.meta?.code),
            )));
      if (!retry || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

import {
  AutomationNotFoundError,
  InvalidQueryError,
  PermissionDeniedError,
  resourceNameSchema,
} from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import { hasPermission } from "../db/casbin";
import type { Principal } from "../db/query/compile";

export async function authorizeQueue(
  db: Prisma.TransactionClient,
  principal: Principal,
  name: string,
) {
  if (!resourceNameSchema.safeParse(name).success)
    throw new InvalidQueryError("Invalid queue name");
  const member = await db.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: principal.orgId,
        userId: principal.userId,
      },
    },
    select: { id: true },
  });
  if (!member) throw new AutomationNotFoundError();
  const queue = await db.queue.findUnique({
    where: { orgId_name: { orgId: principal.orgId, name } },
  });
  if (!queue) throw new AutomationNotFoundError();
  return queue;
}

export async function authorizeQueueAction(
  db: Prisma.TransactionClient,
  principal: Principal,
  name: string,
  action: string,
) {
  const queue = await authorizeQueue(db, principal, name);
  if (
    !(await hasPermission(
      db,
      principal.orgId,
      principal.userId,
      `/queues/${name}`,
      action,
    ))
  )
    throw new PermissionDeniedError();
  return queue;
}
export async function resolveQueueConsumerGrants(
  db: Prisma.TransactionClient,
  principal: Principal,
  name: string,
) {
  const queue = await authorizeQueueAction(db, principal, name, "read");
  await authorizeQueueAction(db, principal, name, "update");
  return queue;
}

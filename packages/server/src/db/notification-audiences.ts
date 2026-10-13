import {
  InvalidQueryError,
  PermissionDeniedError,
  storedNotificationAudience,
  type NotificationAudience,
} from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import type { Enforcer } from "casbin";
import { createOrgEnforcer, getOrgRules, roleSubject } from "./casbin";

export interface NotificationRecipient {
  id: string;
  email: string;
  notificationPreferences: Prisma.JsonValue | null;
  roles: string[];
}

interface OrgNotificationRules {
  roles: Set<string>;
  rolesByUser: Map<string, string[]>;
  enforcer: Enforcer;
}

// Delivery batches reuse each organization's roles and enforcer.
export type NotificationAudienceCache = Map<
  string,
  Promise<OrgNotificationRules>
>;

export interface ResolveNotificationAudienceOptions {
  // Stored user audiences are fixed IDs. Departed recipients are skipped at delivery.
  atDelivery?: boolean;
  cache?: NotificationAudienceCache;
}

async function loadOrgNotificationRules(
  prisma: Prisma.TransactionClient,
  orgId: string,
): Promise<OrgNotificationRules> {
  const rules = await getOrgRules(prisma, orgId);
  const prefix = roleSubject(orgId, "");
  const roles = new Set<string>();
  const rolesByUser = new Map<string, string[]>();
  for (const rule of rules) {
    const subject = rule.ptype === "g" ? rule.v1 : rule.v0;
    if (subject?.startsWith(prefix)) roles.add(subject.slice(prefix.length));
    if (rule.ptype !== "g" || !rule.v0 || !rule.v1?.startsWith(prefix))
      continue;
    const userRoles = rolesByUser.get(rule.v0) ?? [];
    userRoles.push(rule.v1.slice(prefix.length));
    rolesByUser.set(rule.v0, userRoles);
  }
  return {
    roles,
    rolesByUser,
    enforcer: await createOrgEnforcer(prisma, orgId),
  };
}

function orgNotificationRules(
  prisma: Prisma.TransactionClient,
  orgId: string,
  cache?: NotificationAudienceCache,
): Promise<OrgNotificationRules> {
  if (!cache) return loadOrgNotificationRules(prisma, orgId);
  let rules = cache.get(orgId);
  if (!rules) {
    rules = loadOrgNotificationRules(prisma, orgId);
    cache.set(orgId, rules);
  }
  return rules;
}

// Roles describe destinations here; the enforcer still authorizes the sender.
async function authorizeNotificationRecipients(
  prisma: Prisma.TransactionClient,
  orgId: string,
  senderId: string,
  enforcer: Enforcer,
  recipients: NotificationRecipient[],
): Promise<void> {
  const membership = await prisma.member.findUnique({
    where: {
      organizationId_userId: { organizationId: orgId, userId: senderId },
    },
  });
  if (!membership)
    throw new PermissionDeniedError(
      "Notification sender is no longer an organization member",
    );
  for (const recipient of recipients) {
    if (recipient.id === senderId) continue;
    const resources = [
      `/notifications/users/${encodeURIComponent(recipient.id).replaceAll("*", "%2A")}`,
      ...recipient.roles.map((role) => `/notifications/roles/${role}`),
    ];
    let allowed = false;
    for (const resource of resources) {
      if (await enforcer.enforce(senderId, resource, "write")) {
        allowed = true;
        break;
      }
    }
    if (!allowed)
      throw new PermissionDeniedError(
        `Not permitted to notify organization member '${recipient.id}'`,
      );
  }
}

export async function resolveNotificationAudience(
  prisma: Prisma.TransactionClient,
  orgId: string,
  senderId: string,
  value: unknown = { kind: "self" },
  { atDelivery = false, cache }: ResolveNotificationAudienceOptions = {},
): Promise<{
  audience: NotificationAudience;
  recipients: NotificationRecipient[];
}> {
  const audience = storedNotificationAudience(value);
  if (audience.kind === "self") {
    if (
      atDelivery &&
      !(await prisma.member.findUnique({
        where: {
          organizationId_userId: { organizationId: orgId, userId: senderId },
        },
      }))
    )
      throw new PermissionDeniedError(
        "Notification sender is no longer an organization member",
      );
    const user = await prisma.user.findUnique({
      where: { id: senderId },
      select: { id: true, email: true, notificationPreferences: true },
    });
    if (!user) throw new InvalidQueryError("Notification user not found");
    return { audience, recipients: [{ ...user, roles: [] }] };
  }

  const rules = await orgNotificationRules(prisma, orgId, cache);
  if (
    audience.kind === "roles" &&
    !atDelivery &&
    audience.roles.some((role) => !rules.roles.has(role))
  )
    throw new InvalidQueryError(
      "Every selected role must exist in this organization",
    );
  const references =
    audience.kind === "users" ? [...new Set(audience.users)] : [];
  const members = await prisma.member.findMany({
    where: {
      organizationId: orgId,
      user: {
        kind: "human",
        ...(audience.kind === "users"
          ? {
              OR: atDelivery
                ? [{ id: { in: references } }]
                : [{ id: { in: references } }, { email: { in: references } }],
            }
          : {}),
      },
    },
    select: {
      user: {
        select: { id: true, email: true, notificationPreferences: true },
      },
    },
    orderBy: { userId: "asc" },
  });
  let recipients = members.map(({ user }) => ({
    ...user,
    roles: rules.rolesByUser.get(user.id) ?? [],
  }));
  if (
    audience.kind === "users" &&
    !atDelivery &&
    references.some(
      (reference) =>
        !recipients.some(
          (user) => user.id === reference || user.email === reference,
        ),
    )
  )
    throw new InvalidQueryError(
      "Every selected recipient must be a human member of this organization",
    );
  if (audience.kind === "roles") {
    recipients = recipients.filter((user) =>
      user.roles.some((role) => audience.roles.includes(role)),
    );
  }
  await authorizeNotificationRecipients(
    prisma,
    orgId,
    senderId,
    rules.enforcer,
    recipients,
  );
  return {
    audience:
      audience.kind === "users" && !atDelivery
        ? { kind: "users", users: recipients.map((user) => user.id) }
        : audience.kind === "roles"
          ? { kind: "roles", roles: [...new Set(audience.roles)] }
          : audience,
    recipients,
  };
}

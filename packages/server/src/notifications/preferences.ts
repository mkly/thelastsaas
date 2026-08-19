import {
  NOTIFICATION_KINDS,
  type NotificationChannelPreferences,
  type NotificationChannelPreferencesPatch,
  type NotificationKind,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
} from "@lastsaas/shared";

const DEFAULT_PREFERENCES: NotificationChannelPreferences = {
  in_app: true,
  email: true,
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeChannels(
  value: unknown,
  fallback: NotificationChannelPreferences,
): NotificationChannelPreferences {
  const object = asObject(value);
  return {
    in_app:
      typeof object.in_app === "boolean" ? object.in_app : fallback.in_app,
    email: typeof object.email === "boolean" ? object.email : fallback.email,
  };
}

function sameChannels(
  left: NotificationChannelPreferences,
  right: NotificationChannelPreferences,
): boolean {
  return left.in_app === right.in_app && left.email === right.email;
}

function applyPatch(
  current: NotificationChannelPreferences,
  patch: NotificationChannelPreferencesPatch,
): NotificationChannelPreferences {
  return {
    in_app: patch.in_app ?? current.in_app,
    email: patch.email ?? current.email,
  };
}

export function normalizeNotificationPreferences(
  value: unknown,
): NotificationPreferences {
  const object = asObject(value);
  const defaultPreferences = normalizeChannels(
    object.default,
    DEFAULT_PREFERENCES,
  );
  const rawByKind = asObject(object.by_kind);
  const by_kind: NotificationPreferences["by_kind"] = {};

  for (const kind of NOTIFICATION_KINDS) {
    const normalized = normalizeChannels(rawByKind[kind], defaultPreferences);
    if (!sameChannels(normalized, defaultPreferences)) {
      by_kind[kind] = normalized;
    }
  }

  return { default: defaultPreferences, by_kind };
}

export function mergeNotificationPreferences(
  value: unknown,
  patch: NotificationPreferencesPatch,
): NotificationPreferences {
  const current = normalizeNotificationPreferences(value);
  const nextDefault = patch.default
    ? applyPatch(current.default, patch.default)
    : current.default;
  const by_kind: NotificationPreferences["by_kind"] = {};

  for (const kind of NOTIFICATION_KINDS) {
    const existing = current.by_kind[kind] ?? current.default;
    const next = patch.by_kind?.[kind]
      ? applyPatch(current.by_kind[kind] ?? nextDefault, patch.by_kind[kind]!)
      : existing;
    if (!sameChannels(next, nextDefault)) by_kind[kind] = next;
  }

  return { default: nextDefault, by_kind };
}

export function resolveNotificationChannels(
  value: unknown,
  kind: NotificationKind,
): NotificationChannelPreferences {
  const preferences = normalizeNotificationPreferences(value);
  return preferences.by_kind[kind] ?? preferences.default;
}

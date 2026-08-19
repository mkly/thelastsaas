export type FieldDef = string | { type: string; description?: string };
export type Schema = Record<string, FieldDef>;

export type Where =
  | { and: Where[]; or?: never; not?: never }
  | { or: Where[]; and?: never; not?: never }
  | { not: Where; and?: never; or?: never }
  | WhereLeaf;

export type WhereLeaf = Record<string, WhereValue>;
export type WhereValue = string | number | boolean | null | WhereOps;

export interface WhereOps {
  eq?: unknown;
  not?: unknown;
  gt?: unknown;
  lt?: unknown;
  gte?: unknown;
  lte?: unknown;
  contains?: string;
  in?: unknown[];
  is_null?: boolean;
  between?: [unknown, unknown];
  occurs_between?: [string, string];
}

export interface AggregateRequest {
  where?: Where;
  group_by?: string[];
  metrics: AggregateMetric[];
  having?: WhereLeaf;
  order_by?: string;
  limit?: number;
  offset?: number;
}

export type AggregateMetric =
  | { op: "count"; as?: string }
  | { op: "sum" | "avg" | "min" | "max"; field: string; as?: string };

export interface OkResponse {
  status: "ok";
  [key: string]: unknown;
}

export interface Collection {
  id: string;
  name: string;
  schema: Schema;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface CollectionRecord {
  id: string;
  collection?: string;
  data: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface File {
  id: string;
  path: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  collection_id: string | null;
  record_id: string | null;
  uploaded_by: string;
  created_at: string;
}

export interface RowFilter {
  id: string;
  collection: string;
  role: string;
  action: string;
  where: Where;
  created_at: string;
  updated_at: string;
}

export interface FieldFilter {
  id: string;
  collection: string;
  role: string;
  action: string;
  readable_fields: string[];
  writable_fields: string[];
  created_at: string;
  updated_at: string;
}

export type NotificationScheduleKind = "one_shot" | "recurring";

export interface NotificationSchedule {
  id: string;
  kind: NotificationScheduleKind;
  channel: string;
  recipient: string;
  subject: string | null;
  message: string;
  data: Record<string, unknown> | null;
  deliver_at: string | null;
  recurrence: string | null;
  timezone: string | null;
  enabled: boolean;
  next_delivery_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEntry {
  id: string;
  user_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface QueryResult {
  records: CollectionRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface ExportData {
  version: 1;
  collections: Array<{
    name: string;
    schema: Schema;
    description: string;
    records: Array<{
      id: string;
      data: Record<string, unknown>;
      created_by: string;
      created_at: string;
      updated_at: string;
    }>;
  }>;
  files: Array<{
    id: string;
    path: string;
    filename: string;
    mime_type: string | null;
    size_bytes: number | null;
    collection: string | null;
    record_id: string | null;
    uploaded_by: string;
    created_at: string;
    updated_at: string;
  }>;
  policies: Array<{
    subject: string;
    resource: string;
    action: string;
  }>;
  role_assignments: Array<{
    user_id: string;
    role: string;
  }>;
  row_filters: Array<{
    collection: string;
    role: string;
    action: string;
    condition: Where;
  }>;
  field_filters: Array<{
    collection: string;
    role: string;
    action: string;
    readable_fields: string[];
    writable_fields: string[];
  }>;
  notification_schedules: Array<{
    id: string;
    user_id: string;
    dedupe_key: string;
    type: string;
    message: string;
    data: Record<string, unknown> | null;
    in_app: boolean;
    channel: string;
    deliver_at: string | null;
    recurrence: string | null;
    next_occurrence_at: string | null;
    status: string;
    last_enqueued_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
}

export interface ImportResult {
  imported_collections: number;
  imported_records: number;
  imported_files: number;
  imported_policies: number;
  imported_role_assignments: number;
  imported_row_filters: number;
  imported_field_filters: number;
  imported_notification_schedules: number;
  skipped_records?: number;
  warnings?: string[];
}

export interface Stats {
  collections: number;
  records: number;
  files: number;
  storage_bytes: number;
}

export type MemberRole = "owner" | "admin" | "member";

export interface Member {
  user_id: string;
  email: string;
  name: string | null;
  member_role: string;
  casbin_roles: string[];
  joined_at: string;
}

export interface MemberList {
  members: Member[];
  total: number;
  limit: number;
  offset: number;
}

export interface Notification {
  id: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
}

export const NOTIFICATION_KINDS = [
  "invitation",
  "role_assigned",
  "role_unassigned",
  "member_removed",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationChannelPreferences {
  in_app: boolean;
  email: boolean;
}

export interface NotificationChannelPreferencesPatch {
  in_app?: boolean;
  email?: boolean;
}

export interface NotificationPreferences {
  default: NotificationChannelPreferences;
  by_kind: Partial<Record<NotificationKind, NotificationChannelPreferences>>;
}

export interface NotificationPreferencesPatch {
  default?: NotificationChannelPreferencesPatch;
  by_kind?: Partial<
    Record<NotificationKind, NotificationChannelPreferencesPatch>
  >;
}

export interface InvitationPayload {
  invitation_id: string;
  organization_id: string;
  organization_name?: string;
  role: string;
}

export interface RoleAssignedPayload {
  role: string;
  assigned_by_user_id: string;
}

export interface RoleUnassignedPayload {
  role: string;
  unassigned_by_user_id: string;
}

export interface MemberRemovedPayload {
  removed_by_user_id: string;
}

export interface NotificationPayloads {
  invitation: InvitationPayload;
  role_assigned: RoleAssignedPayload;
  role_unassigned: RoleUnassignedPayload;
  member_removed: MemberRemovedPayload;
}

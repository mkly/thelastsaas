-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "notification_preferences" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" DATETIME,
    "refreshTokenExpiresAt" DATETIME,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "inviterId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schema" JSONB NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "collections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "records_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "records_org_id_collection_id_fkey" FOREIGN KEY ("org_id", "collection_id") REFERENCES "collections" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "row_filters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "condition" JSONB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "row_filters_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "row_filters_org_id_collection_id_fkey" FOREIGN KEY ("org_id", "collection_id") REFERENCES "collections" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "field_filters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "readable_fields" JSONB NOT NULL,
    "writable_fields" JSONB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "field_filters_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "field_filters_org_id_collection_id_fkey" FOREIGN KEY ("org_id", "collection_id") REFERENCES "collections" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "collection_id" TEXT,
    "record_id" TEXT,
    "uploaded_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "files_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "files_org_id_collection_id_fkey" FOREIGN KEY ("org_id", "collection_id") REFERENCES "collections" ("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "files_org_id_record_id_fkey" FOREIGN KEY ("org_id", "record_id") REFERENCES "records" ("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "schedule_id" TEXT,
    "occurrence_at" DATETIME,
    "dedupe_key" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "channel" TEXT NOT NULL DEFAULT 'console',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "locked_at" DATETIME,
    "error_logs" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "notifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "notifications_org_id_schedule_id_fkey" FOREIGN KEY ("org_id", "schedule_id") REFERENCES "notification_schedules" ("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notification_schedules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "channel" TEXT NOT NULL DEFAULT 'console',
    "deliver_at" DATETIME,
    "recurrence" TEXT,
    "next_occurrence_at" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "locked_at" DATETIME,
    "last_enqueued_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "notification_schedules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "notification_schedules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "casbin_rule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "org_id" TEXT NOT NULL,
    "ptype" TEXT NOT NULL,
    "v0" TEXT,
    "v1" TEXT,
    "v2" TEXT,
    "v3" TEXT,
    "v4" TEXT,
    "v5" TEXT,
    CONSTRAINT "casbin_rule_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "device_auth_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "user_id" TEXT,
    "expires_at" DATETIME NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "device_auth_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL DEFAULT 'system',
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "details" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");
CREATE INDEX "session_userId_idx" ON "session"("userId");
CREATE INDEX "account_userId_idx" ON "account"("userId");
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");
CREATE INDEX "member_organizationId_idx" ON "member"("organizationId");
CREATE INDEX "member_userId_idx" ON "member"("userId");
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");
CREATE INDEX "invitation_organizationId_idx" ON "invitation"("organizationId");
CREATE INDEX "invitation_email_idx" ON "invitation"("email");
CREATE INDEX "collections_org_id_idx" ON "collections"("org_id");
CREATE UNIQUE INDEX "collections_org_id_name_key" ON "collections"("org_id", "name");
CREATE UNIQUE INDEX "collections_org_id_id_key" ON "collections"("org_id", "id");
CREATE INDEX "records_org_id_collection_id_idx" ON "records"("org_id", "collection_id");
CREATE UNIQUE INDEX "records_org_id_id_key" ON "records"("org_id", "id");
CREATE INDEX "row_filters_org_id_collection_id_action_idx" ON "row_filters"("org_id", "collection_id", "action");
CREATE UNIQUE INDEX "row_filters_org_id_collection_id_role_action_key" ON "row_filters"("org_id", "collection_id", "role", "action");
CREATE INDEX "field_filters_org_id_collection_id_action_idx" ON "field_filters"("org_id", "collection_id", "action");
CREATE UNIQUE INDEX "field_filters_org_id_collection_id_role_action_key" ON "field_filters"("org_id", "collection_id", "role", "action");
CREATE INDEX "files_org_id_collection_id_idx" ON "files"("org_id", "collection_id");
CREATE INDEX "files_org_id_record_id_idx" ON "files"("org_id", "record_id");
CREATE UNIQUE INDEX "files_org_id_path_key" ON "files"("org_id", "path");
CREATE INDEX "notifications_org_id_user_id_read_idx" ON "notifications"("org_id", "user_id", "read");
CREATE INDEX "notifications_status_next_attempt_at_idx" ON "notifications"("status", "next_attempt_at");
CREATE UNIQUE INDEX "notifications_org_id_user_id_dedupe_key_key" ON "notifications"("org_id", "user_id", "dedupe_key");
CREATE UNIQUE INDEX "notifications_org_id_schedule_id_occurrence_at_key" ON "notifications"("org_id", "schedule_id", "occurrence_at");
CREATE INDEX "notification_schedules_status_deliver_at_idx" ON "notification_schedules"("status", "deliver_at");
CREATE INDEX "notification_schedules_status_next_occurrence_at_idx" ON "notification_schedules"("status", "next_occurrence_at");
CREATE INDEX "notification_schedules_org_id_user_id_status_idx" ON "notification_schedules"("org_id", "user_id", "status");
CREATE UNIQUE INDEX "notification_schedules_org_id_id_key" ON "notification_schedules"("org_id", "id");
CREATE UNIQUE INDEX "notification_schedules_org_id_dedupe_key_key" ON "notification_schedules"("org_id", "dedupe_key");
CREATE INDEX "casbin_rule_org_id_ptype_idx" ON "casbin_rule"("org_id", "ptype");
CREATE INDEX "casbin_rule_org_id_v0_idx" ON "casbin_rule"("org_id", "v0");
CREATE UNIQUE INDEX "device_auth_codes_code_key" ON "device_auth_codes"("code");
CREATE INDEX "device_auth_codes_expires_at_idx" ON "device_auth_codes"("expires_at");
CREATE INDEX "audit_log_org_id_created_at_idx" ON "audit_log"("org_id", "created_at");
CREATE INDEX "audit_log_org_id_resource_type_resource_id_idx" ON "audit_log"("org_id", "resource_type", "resource_id");

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'human',
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
    "activeOrganizationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
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
CREATE TABLE "apikey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "start" TEXT,
    "prefix" TEXT,
    "key" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "refillInterval" INTEGER,
    "refillAmount" INTEGER,
    "lastRefillAt" DATETIME,
    "enabled" BOOLEAN DEFAULT true,
    "rateLimitEnabled" BOOLEAN DEFAULT true,
    "rateLimitTimeWindow" INTEGER DEFAULT 86400000,
    "rateLimitMax" INTEGER DEFAULT 10,
    "requestCount" INTEGER DEFAULT 0,
    "remaining" INTEGER,
    "lastRequest" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "permissions" TEXT,
    "metadata" TEXT,
    CONSTRAINT "apikey_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "jwks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    "alg" TEXT,
    "crv" TEXT
);

-- CreateTable
CREATE TABLE "oauthClient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "clientDiscoveryId" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skipConsent" BOOLEAN,
    "enableEndSession" BOOLEAN,
    "subjectType" TEXT,
    "scopes" JSONB,
    "clientCredentialsScopes" JSONB DEFAULT [],
    "userId" TEXT,
    "createdAt" DATETIME,
    "updatedAt" DATETIME,
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" JSONB,
    "tos" TEXT,
    "policy" TEXT,
    "softwareId" TEXT,
    "softwareVersion" TEXT,
    "softwareStatement" TEXT,
    "redirectUris" JSONB NOT NULL,
    "postLogoutRedirectUris" JSONB,
    "backchannelLogoutUri" TEXT,
    "backchannelLogoutSessionRequired" BOOLEAN,
    "tokenEndpointAuthMethod" TEXT,
    "applicationType" TEXT,
    "jwks" TEXT,
    "jwksUri" TEXT,
    "grantTypes" JSONB,
    "responseTypes" JSONB,
    "requirePKCE" BOOLEAN,
    "dpopBoundAccessTokens" BOOLEAN DEFAULT false,
    "referenceId" TEXT,
    "metadata" JSONB,
    CONSTRAINT "oauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauthResource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessTokenTtl" INTEGER,
    "refreshTokenTtl" INTEGER,
    "signingAlgorithm" TEXT,
    "signingKeyId" TEXT,
    "allowedScopes" JSONB,
    "customClaims" JSONB,
    "dpopBoundAccessTokensRequired" BOOLEAN DEFAULT false,
    "disabled" BOOLEAN DEFAULT false,
    "createdAt" DATETIME,
    "updatedAt" DATETIME,
    "policyVersion" INTEGER DEFAULT 1,
    "metadata" JSONB
);

-- CreateTable
CREATE TABLE "oauthClientResource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" DATETIME,
    CONSTRAINT "oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauthRefreshToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" JSONB,
    "requestedUserInfoClaims" JSONB,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "revoked" DATETIME,
    "rotatedAt" DATETIME,
    "rotationReplayResponse" TEXT,
    "rotationReplayExpiresAt" DATETIME,
    "authTime" DATETIME,
    "confirmation" JSONB,
    "scopes" JSONB NOT NULL,
    CONSTRAINT "oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "oauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauthAccessToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" JSONB,
    "requestedUserInfoClaims" JSONB,
    "refreshId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "revoked" DATETIME,
    "confirmation" JSONB,
    "scopes" JSONB NOT NULL,
    CONSTRAINT "oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "oauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "oauthRefreshToken" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauthConsent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "referenceId" TEXT,
    "resources" JSONB,
    "requestedUserInfoClaims" JSONB,
    "scopes" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "oauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "oauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauthClientAssertion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATETIME NOT NULL
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
    "permissions" TEXT NOT NULL DEFAULT '[]',
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
    CONSTRAINT "files_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "files_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "records" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_by_user_id" TEXT,
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
    "error_logs" JSONB,
    "channel_results" JSONB,
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
    "audience" JSONB NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
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
CREATE TABLE "deviceCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceCode" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "userId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "lastPolledAt" DATETIME,
    "pollingInterval" INTEGER,
    "clientId" TEXT,
    "scope" TEXT
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

-- CreateTable
CREATE TABLE "mcp_organization" (
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,

    PRIMARY KEY ("userId", "clientId"),
    CONSTRAINT "mcp_organization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mcp_organization_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "file_upload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "filename" TEXT,
    "path" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "secrets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_version" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "secrets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "queues" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schema" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "retry_delay_seconds" INTEGER NOT NULL DEFAULT 30,
    "lease_seconds" INTEGER NOT NULL DEFAULT 60,
    "retention_days" INTEGER NOT NULL DEFAULT 7,
    CONSTRAINT "queues_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "queue_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "queue_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "producer_user_id" TEXT,
    "available_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" TEXT,
    "idempotency_hash" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_by" TEXT,
    "claim_token_hash" TEXT,
    "native_claim_token" TEXT,
    "claimed_attempt" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "queue_entries_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "queue_entries_producer_user_id_fkey" FOREIGN KEY ("producer_user_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "transaction_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "visibility" JSONB NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transaction_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "queue_schedules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "queue_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "deliver_at" DATETIME,
    "recurrence" TEXT,
    "timezone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "pause_reason" TEXT,
    "cursor_at" DATETIME,
    "next_occurrence_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "queue_schedules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "queue_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "queue_schedules_org_id_queue_id_fkey" FOREIGN KEY ("org_id", "queue_id") REFERENCES "queues" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "collection_triggers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "org_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "queue_id" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "watched_fields" JSONB,
    "where" JSONB,
    "mapping" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "pause_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "collection_triggers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "collection_triggers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "collection_triggers_org_id_collection_id_fkey" FOREIGN KEY ("org_id", "collection_id") REFERENCES "collections" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "collection_triggers_org_id_queue_id_fkey" FOREIGN KEY ("org_id", "queue_id") REFERENCES "queues" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "queue_schedule_occurrences" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schedule_id" TEXT NOT NULL,
    "occurrence_at" DATETIME NOT NULL,
    "entry_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "queue_schedule_occurrences_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "queue_schedules" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "job_outbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "message" JSONB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_issuer_accountId_key" ON "account"("issuer", "accountId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "apikey_configId_idx" ON "apikey"("configId");

-- CreateIndex
CREATE INDEX "apikey_key_idx" ON "apikey"("key");

-- CreateIndex
CREATE INDEX "apikey_referenceId_idx" ON "apikey"("referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "oauthClient_clientId_key" ON "oauthClient"("clientId");

-- CreateIndex
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oauthResource_identifier_key" ON "oauthResource"("identifier");

-- CreateIndex
CREATE INDEX "oauthClientResource_clientId_idx" ON "oauthClientResource"("clientId");

-- CreateIndex
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauthClientResource"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_key" ON "oauthClientResource"("clientId", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "oauthRefreshToken_token_key" ON "oauthRefreshToken"("token");

-- CreateIndex
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken"("clientId");

-- CreateIndex
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken"("sessionId");

-- CreateIndex
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken"("userId");

-- CreateIndex
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken"("authorizationCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "oauthAccessToken_token_key" ON "oauthAccessToken"("token");

-- CreateIndex
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken"("clientId");

-- CreateIndex
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken"("sessionId");

-- CreateIndex
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken"("userId");

-- CreateIndex
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken"("authorizationCodeId");

-- CreateIndex
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken"("refreshId");

-- CreateIndex
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent"("clientId");

-- CreateIndex
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE INDEX "member_organizationId_idx" ON "member"("organizationId");

-- CreateIndex
CREATE INDEX "member_userId_idx" ON "member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "invitation_organizationId_idx" ON "invitation"("organizationId");

-- CreateIndex
CREATE INDEX "invitation_email_idx" ON "invitation"("email");

-- CreateIndex
CREATE INDEX "collections_org_id_idx" ON "collections"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "collections_org_id_name_key" ON "collections"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "collections_org_id_id_key" ON "collections"("org_id", "id");

-- CreateIndex
CREATE INDEX "records_org_id_collection_id_idx" ON "records"("org_id", "collection_id");

-- CreateIndex
CREATE UNIQUE INDEX "records_org_id_id_key" ON "records"("org_id", "id");

-- CreateIndex
CREATE INDEX "row_filters_org_id_collection_id_action_idx" ON "row_filters"("org_id", "collection_id", "action");

-- CreateIndex
CREATE UNIQUE INDEX "row_filters_org_id_collection_id_role_action_key" ON "row_filters"("org_id", "collection_id", "role", "action");

-- CreateIndex
CREATE INDEX "field_filters_org_id_collection_id_action_idx" ON "field_filters"("org_id", "collection_id", "action");

-- CreateIndex
CREATE UNIQUE INDEX "field_filters_org_id_collection_id_role_action_key" ON "field_filters"("org_id", "collection_id", "role", "action");

-- CreateIndex
CREATE INDEX "files_org_id_collection_id_idx" ON "files"("org_id", "collection_id");

-- CreateIndex
CREATE INDEX "files_org_id_record_id_idx" ON "files"("org_id", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "files_org_id_path_key" ON "files"("org_id", "path");

-- CreateIndex
CREATE INDEX "notifications_org_id_user_id_read_idx" ON "notifications"("org_id", "user_id", "read");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_org_id_user_id_dedupe_key_key" ON "notifications"("org_id", "user_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_org_id_schedule_id_occurrence_at_user_id_key" ON "notifications"("org_id", "schedule_id", "occurrence_at", "user_id");

-- CreateIndex
CREATE INDEX "notification_schedules_status_deliver_at_idx" ON "notification_schedules"("status", "deliver_at");

-- CreateIndex
CREATE INDEX "notification_schedules_status_next_occurrence_at_idx" ON "notification_schedules"("status", "next_occurrence_at");

-- CreateIndex
CREATE INDEX "notification_schedules_org_id_user_id_status_idx" ON "notification_schedules"("org_id", "user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_schedules_org_id_id_key" ON "notification_schedules"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_schedules_org_id_user_id_dedupe_key_key" ON "notification_schedules"("org_id", "user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "casbin_rule_org_id_ptype_idx" ON "casbin_rule"("org_id", "ptype");

-- CreateIndex
CREATE INDEX "casbin_rule_org_id_v0_idx" ON "casbin_rule"("org_id", "v0");

-- CreateIndex
CREATE UNIQUE INDEX "deviceCode_deviceCode_key" ON "deviceCode"("deviceCode");

-- CreateIndex
CREATE UNIQUE INDEX "deviceCode_userCode_key" ON "deviceCode"("userCode");

-- CreateIndex
CREATE INDEX "audit_log_org_id_created_at_idx" ON "audit_log"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_org_id_resource_type_resource_id_idx" ON "audit_log"("org_id", "resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_upload_tokenHash_key" ON "file_upload"("tokenHash");

-- CreateIndex
CREATE INDEX "file_upload_expiresAt_idx" ON "file_upload"("expiresAt");

-- CreateIndex
CREATE INDEX "file_upload_orgId_userId_idx" ON "file_upload"("orgId", "userId");

-- CreateIndex
CREATE INDEX "secrets_org_id_created_at_id_idx" ON "secrets"("org_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "secrets_org_id_key_version_id_idx" ON "secrets"("org_id", "key_version", "id");

-- CreateIndex
CREATE UNIQUE INDEX "secrets_org_id_name_key" ON "secrets"("org_id", "name");

-- CreateIndex
CREATE INDEX "queues_org_id_id_idx" ON "queues"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "queues_org_id_name_key" ON "queues"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "queues_org_id_id_key" ON "queues"("org_id", "id");

-- CreateIndex
CREATE INDEX "queue_entries_queue_id_created_at_id_idx" ON "queue_entries"("queue_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_entries_queue_id_id_key" ON "queue_entries"("queue_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_entries_queue_id_idempotency_key_key" ON "queue_entries"("queue_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "transaction_requests_expires_at_idx" ON "transaction_requests"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_requests_org_id_principal_id_key_key" ON "transaction_requests"("org_id", "principal_id", "key");

-- CreateIndex
CREATE INDEX "queue_schedules_status_next_occurrence_at_id_idx" ON "queue_schedules"("status", "next_occurrence_at", "id");

-- CreateIndex
CREATE INDEX "queue_schedules_org_id_created_at_id_idx" ON "queue_schedules"("org_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "queue_schedules_org_id_created_by_status_idx" ON "queue_schedules"("org_id", "created_by", "status");

-- CreateIndex
CREATE UNIQUE INDEX "queue_schedules_org_id_id_key" ON "queue_schedules"("org_id", "id");

-- CreateIndex
CREATE INDEX "collection_triggers_org_id_created_at_id_idx" ON "collection_triggers"("org_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "collection_triggers_org_id_collection_id_status_idx" ON "collection_triggers"("org_id", "collection_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "queue_schedule_occurrences_schedule_id_occurrence_at_key" ON "queue_schedule_occurrences"("schedule_id", "occurrence_at");

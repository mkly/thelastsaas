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
CREATE UNIQUE INDEX "file_upload_tokenHash_key" ON "file_upload"("tokenHash");
CREATE INDEX "file_upload_expiresAt_idx" ON "file_upload"("expiresAt");
CREATE INDEX "file_upload_orgId_userId_idx" ON "file_upload"("orgId", "userId");

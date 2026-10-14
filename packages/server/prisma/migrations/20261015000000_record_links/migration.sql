-- AlterTable
ALTER TABLE "file_upload" ADD COLUMN "attachment" JSONB;

-- CreateTable
CREATE TABLE "record_references" (
    "org_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    PRIMARY KEY ("source_id", "field", "target_id"),
    CONSTRAINT "record_references_org_id_source_id_fkey" FOREIGN KEY ("org_id", "source_id") REFERENCES "records" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "record_references_org_id_target_id_fkey" FOREIGN KEY ("org_id", "target_id") REFERENCES "records" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "record_attachments" (
    "org_id" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    PRIMARY KEY ("record_id", "field", "file_id"),
    CONSTRAINT "record_attachments_org_id_record_id_fkey" FOREIGN KEY ("org_id", "record_id") REFERENCES "records" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "record_attachments_org_id_file_id_fkey" FOREIGN KEY ("org_id", "file_id") REFERENCES "files" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "record_history_files" (
    "org_id" TEXT NOT NULL,
    "history_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,

    PRIMARY KEY ("history_id", "field", "file_id"),
    CONSTRAINT "record_history_files_org_id_history_id_fkey" FOREIGN KEY ("org_id", "history_id") REFERENCES "record_history" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "record_history_files_org_id_file_id_fkey" FOREIGN KEY ("org_id", "file_id") REFERENCES "files" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_files" (
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
    "standalone" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "files_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "files_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "files_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "records" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_files" ("collection_id", "created_at", "filename", "id", "mime_type", "org_id", "path", "record_id", "size_bytes", "updated_at", "uploaded_by") SELECT "collection_id", "created_at", "filename", "id", "mime_type", "org_id", "path", "record_id", "size_bytes", "updated_at", "uploaded_by" FROM "files";
DROP TABLE "files";
ALTER TABLE "new_files" RENAME TO "files";
CREATE INDEX "files_org_id_collection_id_idx" ON "files"("org_id", "collection_id");
CREATE INDEX "files_org_id_record_id_idx" ON "files"("org_id", "record_id");
CREATE UNIQUE INDEX "files_org_id_id_key" ON "files"("org_id", "id");
CREATE UNIQUE INDEX "files_org_id_path_key" ON "files"("org_id", "path");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "record_references_org_id_target_id_idx" ON "record_references"("org_id", "target_id");

-- CreateIndex
CREATE INDEX "record_attachments_org_id_file_id_idx" ON "record_attachments"("org_id", "file_id");

-- CreateIndex
CREATE INDEX "record_history_files_org_id_file_id_idx" ON "record_history_files"("org_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "record_history_org_id_id_key" ON "record_history"("org_id", "id");

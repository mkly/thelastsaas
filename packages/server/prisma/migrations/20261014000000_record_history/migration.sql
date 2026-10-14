-- CreateTable
CREATE TABLE "record_history" (
    "position" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "change_set_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "record_history_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "record_history_org_id_collection_id_fkey" FOREIGN KEY ("org_id", "collection_id") REFERENCES "collections" ("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "record_history_id_key" ON "record_history"("id");

-- CreateIndex
CREATE INDEX "record_history_org_id_collection_id_position_idx" ON "record_history"("org_id", "collection_id", "position");

-- CreateIndex
CREATE INDEX "record_history_org_id_collection_id_record_id_position_idx" ON "record_history"("org_id", "collection_id", "record_id", "position");

-- CreateIndex
CREATE INDEX "record_history_org_id_change_set_id_idx" ON "record_history"("org_id", "change_set_id");

-- CreateIndex
CREATE INDEX "record_history_created_at_idx" ON "record_history"("created_at");

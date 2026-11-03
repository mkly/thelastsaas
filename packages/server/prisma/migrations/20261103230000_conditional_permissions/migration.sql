DROP TABLE "row_filters";
DROP TABLE "field_filters";
CREATE TABLE "new_casbin_rule" (
 "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "org_id" TEXT NOT NULL,
 "ptype" TEXT NOT NULL, "v0" TEXT, "v1" TEXT, "v2" TEXT,
 "v3" TEXT DEFAULT 'true', "v4" TEXT DEFAULT '', "v5" TEXT,
 CONSTRAINT "casbin_rule_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_casbin_rule" SELECT * FROM "casbin_rule";
DROP TABLE "casbin_rule";
ALTER TABLE "new_casbin_rule" RENAME TO "casbin_rule";
CREATE INDEX "casbin_rule_org_id_ptype_idx" ON "casbin_rule"("org_id", "ptype");
CREATE INDEX "casbin_rule_org_id_v0_idx" ON "casbin_rule"("org_id", "v0");

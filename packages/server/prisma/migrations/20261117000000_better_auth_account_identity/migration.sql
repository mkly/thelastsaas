BEGIN IMMEDIATE;

-- SQLite cannot relax NOT NULL in place. Copy only the issuer column.
DROP INDEX "account_issuer_accountId_key";
ALTER TABLE "account" RENAME COLUMN "issuer" TO "previousIssuer";
ALTER TABLE "account" ADD COLUMN "issuer" TEXT;
UPDATE "account" SET "issuer" = "previousIssuer";
ALTER TABLE "account" DROP COLUMN "previousIssuer";

COMMIT;

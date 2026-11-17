BEGIN;

ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
DROP INDEX "account_issuer_accountId_key";

COMMIT;

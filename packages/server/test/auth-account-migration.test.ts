import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function migration(name: string) {
  return readFileSync(
    new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
    "utf8",
  );
}

test("the account upgrade preserves every row, including duplicate provider keys, and accepts new accounts without an issuer", () => {
  const db = new Database(":memory:");
  try {
    db.exec(migration("20261011000000_init"));
    db.exec(`
      INSERT INTO user (id, name, email, updatedAt)
      VALUES ('one', 'One', 'one@example.test', CURRENT_TIMESTAMP),
             ('two', 'Two', 'two@example.test', CURRENT_TIMESTAMP);
      INSERT INTO account (id, userId, issuer, providerId, accountId, password, updatedAt)
      VALUES ('a', 'one', 'old-a', 'credential', 'same-id', 'stored-hash', CURRENT_TIMESTAMP),
             ('b', 'two', 'old-b', 'credential', 'same-id', NULL, CURRENT_TIMESTAMP);
    `);
    const upgrade = migration("20261117000000_better_auth_account_identity");
    const accounts = () =>
      db.prepare("SELECT * FROM account ORDER BY id").all();
    const before = accounts();
    db.exec(upgrade);
    expect(accounts()).toEqual(before);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name = 'account_issuer_accountId_key'",
        )
        .get(),
    ).toBeNull();
    const insert = db.query(
      "INSERT INTO account (id, userId, providerId, accountId, updatedAt) VALUES (?, 'one', 'google', ?, CURRENT_TIMESTAMP)",
    );
    insert.run("new", "new-id");
    expect(
      db.query("SELECT issuer FROM account WHERE id = 'new'").get(),
    ).toEqual({ issuer: null });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

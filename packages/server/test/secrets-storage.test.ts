import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptSecret, encryptSecret } from "../src/secrets/crypto";
import { loadSecretKeyring } from "../src/secrets/keyring";

test("secret storage enforces organization constraints", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-secrets-"));
  const path = join(directory, "test.sqlite");
  const database = new Database(path);
  const prisma = new PrismaClient({ datasourceUrl: `file:${path}` });
  try {
    database.exec("PRAGMA foreign_keys=ON");
    const migrations = fileURLToPath(
      new URL("../prisma/migrations", import.meta.url),
    );
    for (const migration of readdirSync(migrations).sort()) {
      if (!migration.match(/^\d/)) continue;
      database.exec(
        readFileSync(join(migrations, migration, "migration.sql"), "utf8"),
      );
    }
    await prisma.organization.create({
      data: { id: "org-one", name: "Existing", slug: "existing" },
    });
    await prisma.organization.create({
      data: { id: "org-two", name: "Other", slug: "other" },
    });
    const ring = loadSecretKeyring({
      SECRETS_ACTIVE_KEY_VERSION: "v1",
      SECRETS_KEYRING: JSON.stringify({
        v1: Buffer.alloc(32, 17).toString("base64"),
      }),
    });
    const identity = { orgId: "org-one", id: "secret-one" };
    const data = {
      ...identity,
      name: "credential",
      ...encryptSecret(ring, identity, "private-credential"),
    };
    const stored = await prisma.secret.create({ data });
    expect(decryptSecret(ring, identity, stored)).toBe("private-credential");
    expect(JSON.stringify(stored)).not.toContain("private-credential");
    await expect(
      Promise.resolve(
        prisma.secret.create({ data: { ...data, id: "duplicate" } }),
      ),
    ).rejects.toThrow();
    const secondIdentity = { orgId: "org-two", id: "secret-two" };
    await prisma.secret.create({
      data: {
        ...secondIdentity,
        name: data.name,
        ...encryptSecret(ring, secondIdentity, "other-credential"),
      },
    });
    await expect(
      Promise.resolve(
        prisma.secret.create({
          data: { ...data, id: "foreign", orgId: "missing" },
        }),
      ),
    ).rejects.toThrow();
    await prisma.organization.delete({ where: { id: identity.orgId } });
    expect(
      await prisma.secret.count({ where: { orgId: identity.orgId } }),
    ).toBe(0);
    expect(
      await prisma.secret.count({ where: { orgId: secondIdentity.orgId } }),
    ).toBe(1);
  } finally {
    await prisma.$disconnect();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

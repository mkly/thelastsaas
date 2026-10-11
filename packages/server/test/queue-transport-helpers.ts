import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { addPolicy } from "../src/db/casbin";
import { createServices, type AppServices } from "../src/services";
import { testMigrationSql } from "./test-migrations";

// Each call owns a fresh database; no fixture state is shared across parallel files.
export async function createQueueTransportFixture(
  prefix: string,
  apiKeys: boolean,
) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL:
      process.env.QUEUE_SERVICE_TEST_DATABASE_URL ??
      `file:${join(directory, "test.sqlite")}`,
    STORAGE_PATH: join(directory, "files"),
  });
  const services = await createServices(config);
  if (services.database) services.database.exec(testMigrationSql);
  else {
    await services.prisma.organization.deleteMany();
    await services.prisma.user.deleteMany();
  }
  await services.prisma.organization.createMany({
    data: [
      { id: "org_one", name: "One", slug: "one" },
      { id: "org_two", name: "Two", slug: "two" },
    ],
  });
  for (const id of ["admin", "reader", "foreign"]) {
    await services.prisma.user.create({
      data: {
        id,
        email: `${id}@example.com`,
        name: id,
        kind: id === "reader" ? "service" : "human",
      },
    });
    await services.prisma.member.create({
      data: {
        id: `member_${id}`,
        userId: id,
        organizationId: id === "foreign" ? "org_two" : "org_one",
      },
    });
  }
  await addPolicy(services.prisma, "org_one", "admin", "/*", "*");
  await addPolicy(services.prisma, "org_two", "foreign", "/*", "*");
  // Authentication mechanics are covered elsewhere; keep real middleware, membership and ACLs.
  services.auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-test-user");
        return id
          ? { session: { id: `session_${id}` }, user: { id, name: id } }
          : null;
      },
      ...(apiKeys
        ? {
            verifyApiKey: async ({ body }: { body: { key: string } }) => ({
              valid: true,
              key: {
                referenceId: body.key,
                metadata: { organizationId: "org_one" },
              },
            }),
          }
        : {}),
    },
  } as unknown as AppServices["auth"];
  const app = createApp({ config, services });
  return { directory, config, services, app };
}

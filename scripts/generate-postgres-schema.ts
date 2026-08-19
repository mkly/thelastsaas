import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../packages/server/prisma/schema.prisma", import.meta.url),
);
const destination = fileURLToPath(
  new URL("../packages/server/prisma/schema.postgres.prisma", import.meta.url),
);

const sqliteProvider = 'provider = "sqlite"';
const postgresProvider = 'provider = "postgresql"';
const schema = await readFile(source, "utf8");
const matches = schema.match(/provider\s*=\s*"sqlite"/g) ?? [];

if (matches.length !== 1 || !schema.includes(sqliteProvider)) {
  throw new Error(
    `Expected exactly one canonical ${sqliteProvider} datasource declaration`,
  );
}

await writeFile(destination, schema.replace(sqliteProvider, postgresProvider));
console.log(`Generated ${destination}`);

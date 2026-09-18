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

// Keep the deployment-specific index in the generated Prisma schema so db
// push and migrations both manage it. SQLite retains its ordinary scope index.
const recordIndex = "  @@index([orgId, collectionId])";
const recordStart = schema.indexOf("model Record {");
const indexAt = schema.indexOf(recordIndex, recordStart);
if (
  recordStart < 0 ||
  indexAt < 0 ||
  indexAt > schema.indexOf("model RowFilter {")
) {
  throw new Error("Could not locate the Record model scope index");
}
const postgresSchema = (
  schema.slice(0, indexAt) +
  '  @@index([data(ops: JsonbPathOps)], type: Gin, map: "records_data_gin_idx")\n' +
  schema.slice(indexAt)
).replace(sqliteProvider, postgresProvider);
await writeFile(destination, postgresSchema);
console.log(`Generated ${destination}`);

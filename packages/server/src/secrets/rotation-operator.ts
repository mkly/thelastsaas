import { PrismaClient } from "@prisma/client";
import { parseArgs } from "node:util";
import { loadSecretKeyring } from "./keyring";
import { rotateSecretBatch } from "./rotation";

// Local operator tooling only: database/keyring access is required. No HTTP/MCP
// registration. The process already holds the database and encryption keys.
export async function runSecretRotationOperator() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      org: { type: "string" },
      "key-version": { type: "string" },
      limit: { type: "string", default: "100" },
      cursor: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!process.env.DATABASE_URL || !values.org || !values["key-version"])
    throw new Error();
  const keyring = loadSecretKeyring(process.env);
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const result = await rotateSecretBatch(prisma, keyring, values.org, {
      key_version: values["key-version"],
      limit: Number(values.limit),
      ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
    });
    console.log(JSON.stringify({ status: "ok", ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

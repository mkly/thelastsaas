import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
  type RawBuilder,
  type Compilable,
} from "kysely";
import type { Prisma } from "@prisma/client";
import type { DB } from "../generated/types";
import type { DbProvider } from "./adapters/types";

export { sql };
export type SqlFragment = RawBuilder<unknown>;

// Compilation only: Prisma owns connections, result decoding and transactions.
const builders = {
  postgresql: new Kysely<DB>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }),
  sqlite: new Kysely<DB>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => new SqliteAdapter(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  }),
};

export function queryBuilder(provider: DbProvider): Kysely<DB> {
  return builders[provider];
}

export function compileSql(
  expression: SqlFragment | Compilable<unknown>,
  provider: DbProvider,
) {
  return expression.compile(queryBuilder(provider));
}

export function queryRows<T>(
  prisma: Prisma.TransactionClient,
  provider: DbProvider,
  expression: SqlFragment | Compilable<unknown>,
): Promise<T[]> {
  const compiled = compileSql(expression, provider);
  return prisma.$queryRawUnsafe<T[]>(compiled.sql, ...compiled.parameters);
}

export function executeStatement(
  prisma: Prisma.TransactionClient,
  provider: DbProvider,
  expression: SqlFragment | Compilable<unknown>,
): Promise<number> {
  const compiled = compileSql(expression, provider);
  return prisma.$executeRawUnsafe(compiled.sql, ...compiled.parameters);
}

import { postgresAdapter } from "./postgres";
import { sqliteAdapter } from "./sqlite";
import type { DbProvider, QueryAdapter } from "./types";

export type { DbProvider, QueryAdapter, SqlFragment } from "./types";

const adapters: Record<DbProvider, QueryAdapter> = {
  postgresql: postgresAdapter,
  sqlite: sqliteAdapter,
};
export function queryAdapter(provider: DbProvider): QueryAdapter {
  return adapters[provider];
}

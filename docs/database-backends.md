# Database backends

PostgreSQL is the primary backend for larger deployments. SQLite is a supported
alternative for simple, self-contained open-source deployments. SQLite is not
an automatic failover database. Both expose the same collection, record, filter,
and permission APIs.

## Shared model and separate query adapters

Both backends store collection schemas as metadata and records in the shared
`records` table with `org_id`, `collection_id`, and JSON `data`. Creating a
collection does not create a database table.

The shared query compiler validates field references, combines API filters with
permission predicates, and handles aggregates and recurrence post-filters.
`packages/server/src/db/query/adapters/` owns JSON expressions, bound values,
placeholder syntax, and the SQL used to evaluate candidate record grants.
The adapter is selected from the datasource configured for each Prisma client.
Prisma continues to own execution, connections, and transactions.

PostgreSQL scalar equality uses JSONB containment:

```sql
SELECT id, data FROM records
WHERE org_id = $1 AND collection_id = $2
  AND data @> CAST($3 AS jsonb);
-- $3 = '{"status":"open"}'
```

SQLite evaluates the same filter with `json_extract(data, '$.status') = ?`.
Equality values must match the declared scalar type; a number field takes `42`,
not `"42"`. No conversion of legacy stored values is performed. Metadata fields
use their native columns. Untyped `json` fields use extraction comparisons rather
than treating scalar equality as document containment.

Numeric range comparisons, sorting, and aggregates use typed expressions.
JSON-field sorting places null/missing values last ascending and first descending
on both backends. Use `is_null` to match null or missing fields; equality with
null does not match a row. Negated comparisons retain SQL's unknown result for
missing/null values, including in permission predicates. Recurrence expansion
remains shared application logic after SQL candidate selection.

## PostgreSQL indexes and deployment

Generate and apply the PostgreSQL schema:

```sh
bun run --cwd packages/server prisma:push:postgres
bun run build:server:postgres
```

Set `DATABASE_URL` to the target PostgreSQL database as usual. The generated
Prisma schema includes `records_data_gin_idx`, a GIN index on `data` with
`jsonb_path_ops`, alongside the existing organization/collection index. This
indexes supported JSONB containment queries; it is not a general index for all
JSON operations. Ranges, ordering, substring searches, and aggregation may still
scan candidate records and need workload-specific indexes.

The database planner decides whether to use GIN, the scope index, or a scan.
Index creation on an existing deployment can take time and requires the normal
schema deployment process; it is not performed during server startup. Existing
records stay in place and are not rewritten by this query-adapter change.

SQLite uses the canonical Prisma schema and SQLite migrations. It does not get
the PostgreSQL GIN index. Its performance characteristics differ, but access
control is enforced on both backends.

## Supported collection schema edits

Adding new fields, removing fields, and editing descriptions remain supported.
Changing an existing field's type is unsupported, including through `add_fields`
or changes to an enum/ref type definition. An identical type is allowed when
editing a description.

Removing a field does not erase stored JSON values. Re-adding a removed name
while any record still contains it is unsupported, to prevent a remove/add
sequence from silently reinterpreting existing values. No automatic data
migration or compatibility conversion is supplied. An explicit type-migration
workflow may be added in the future.

## Backend contract tests

The same integration tests exercise records, filters, counts, aggregation,
permissions, writes, schema restrictions, and recurrence expansion on both
backends:

```sh
bun run --cwd packages/server prisma:generate
bun test packages/server/test/query-backends.test.ts

TEST_POSTGRES_URL=postgresql://user:password@localhost/testdb bun run test:postgres
```

The PostgreSQL runner creates a unique schema in the supplied test database,
applies the generated schema, runs the contract tests, drops its schema, and
restores the SQLite Prisma client. It also verifies that the generated equality
predicate can use the GIN index. Run it separately from SQLite tests because
Prisma client generation selects one provider at a time. These checks establish
correctness and index eligibility, not a production performance benchmark.

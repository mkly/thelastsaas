# Key Patterns

## Dynamic schemas

Fields use either a type string or `{ "type": "...", "description": "..." }`.
Supported types are string, text, number, integer, float, boolean, date,
datetime, JSON, recurrence, enums, and collection references. Field names are
validated before interpolation into SQLite JSON expressions.

## Where DSL

Boolean nodes contain exactly one of `and`, `or`, or `not`. Leaf fields accept
a scalar equality value or `eq`, `not`, `gt`, `lt`, `gte`, `lte`, `contains`,
`in`, `is_null`, `between`, and `occurs_between`. User predicates and applicable
row filters are composed before querying.

`contains` escapes SQL wildcard characters. Empty `in` lists are always false.
Limits are bounded. Aggregate aliases may be used by `having` and `order_by`.

## Permission composition

For each operation, reason through these layers in order:

1. Casbin policy for subject, resource, and action.
2. Row filter for collection, role, and action, expressed as Where.
3. Field filter for collection, role, and action, expressed as readable and
   writable field-name arrays.

If any granting role is unrestricted at a layer, that layer is unrestricted.
Otherwise matching role filters are unioned appropriately. Substitutions in row
filters are `$user.id`, `$user.email`, and `$org.id`.

## Recurrence

Store local recurrence content with `DTSTART;TZID`, `RRULE`, and optional
`EXDATE`. Expansion must have a bounded UTC window. Row filtering happens before
expansion; pagination happens after expansion. A field hidden by a field filter
cannot be referenced by `occurs_between`.

To change one occurrence, exclude its original local start from the series and
write a linked standalone record. This keeps exceptions visible to ordinary
record queries and access rules.

## Storage and database providers

Stream uploads directly to the configured `Storage` implementation. Database
rows hold metadata; object keys use organization and file IDs. Validate relative
paths and enforce the configured size limit before committing metadata.

Keep `schema.prisma` provider-neutral except for its SQLite provider literal.
Generate the PostgreSQL schema; do not hand-maintain a second model definition.

## Errors

Domain failures extend `LastSaasError` and serialize through `errorResponse`.
Malformed request bodies return 400, missing resources return 404, and denied
fields or policies return 403. CLI handlers convert failed responses to
`CliError` so command exit codes remain nonzero and predictable.

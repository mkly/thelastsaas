# Record relationships

A single reference uses `"company":"ref:companies"`. A multiple reference uses
`"partners":{"type":"ref:companies","multiple":true}`. Values are record IDs;
multiple values are ordered lists of up to 100 unique IDs. Null clears a single
reference; an empty list clears a multiple reference.

```sh
saas collections create companies --schema '{"name":"string"}'
saas collections create contacts --schema '{"name":"string","company":"ref:companies","partners":{"type":"ref:companies","multiple":true}}'
saas records update contacts <contact-id> --data '{"company":"<company-id>","partners":["<partner-id>"]}'
```

Newly assigned targets must exist in the declared collection, belong to the same
organization, and be readable by the acting account. Unavailable and forbidden
targets produce the same validation error. Existing unchanged links do not need
to be reassigned when the actor loses access to a target.

Record JSON and indexed relationship rows commit together, including batch and
atomic transaction writes. Changes appear in record history and ordinary record
triggers. Deleting a referenced record or collection returns a conflict until
incoming links are removed. Deleting a source removes its outgoing links.

Organization import accepts empty reference and attachment fields; populated
fields are rejected because imported record and file IDs are not remapped.

## Read and expand

```sh
saas records get contacts <id> --expand company,company.parent
saas records query contacts --expand company --where '{"company":"<company-id>"}'
saas records query contacts --where '{"partners":{"has":"<company-id>"}}'
saas records related companies <company-id> --source contacts --field company
```

REST record GET accepts comma-separated `expand` paths. Record query accepts an
`expand` array. MCP `records_get` and `records_query` accept the same array.
Expanded objects live under `expand`; stored IDs remain in `data`. Multiple
references retain their ordering. An inaccessible or missing target is `null`.
Source field permissions and each target's row and field permissions apply.

Expansion accepts up to 20 paths, four relationship levels, and 2,000 expanded
records/file metadata objects per response. Exceeding a bound returns an error
with guidance to reduce the query; results are not silently truncated.

`collections_describe` includes authorized inbound and outbound relationship
field definitions. Reverse traversal uses MCP `records_related`, CLI
`records related`, or REST
`POST /v1/orgs/:orgId/collections/:name/records/:id/related` with
`source_collection`, `field`, and optional `where`, `order_by`, `limit`, `offset`,
and `expand`. It checks access to the target record and filters source records
using their ordinary permissions.

## Filter related records

```json
{ "company": { "some": { "name": "Acme" } } }
```

`some` matches at least one readable target satisfying the condition. `none`
matches no such target. `every` requires all readable targets to satisfy the
condition; an empty readable set satisfies `every`. These operators work on
single and multiple references and support nested relationship predicates up to
four levels. `has` tests a specific ID in a multiple-reference list.

Relationship predicates run in SQL before pagination, counts, and aggregates.
Hidden target fields cannot be used to filter. Only readable targets participate
in related conditions; links never grant access to a target. Relationship
predicates are record-query operations; row permission rules use the ordinary
field predicates, including reference ID equality and multiple-reference `has`.

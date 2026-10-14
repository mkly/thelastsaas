# Record attachments

An `attachments` schema field contains an ordered list of up to 100 unique file
IDs. Records can have several attachment fields. Record GET and query responses
include permitted file metadata under `attachments`, keyed by field name; `data`
retains the IDs.

```sh
saas collections update-schema deals --add '{"contracts":"attachments"}'
saas files upload proposal.pdf --collection deals --record <deal-id> --field contracts
saas records get deals <deal-id>
saas files download <file-id> --output proposal.pdf
```

## Upload into a record

MCP `files_upload_link` accepts an optional `attachment` destination:

```json
{
  "attachment": {
    "collection": "deals",
    "record_id": "<deal-id>",
    "field": "contracts"
  }
}
```

The user opens the returned browser link and selects a file. Completion appends
its ID to the destination field. The destination is fixed when the upload is
created and is shown on the browser upload page.

`files_prepare_upload` accepts the same destination alongside filename, size,
and MIME metadata. Transfer bytes to the returned PUT URL, then call
`files_complete_upload`. REST accepts the destination on
`POST /v1/orgs/:orgId/files/uploads/link` and
`POST /v1/orgs/:orgId/files/uploads`.

Creating and completing an attachment upload require current organization
membership and update permission on the destination record and field. General
file-library write permission is not required. Completion rechecks the
permissions and destination, then publishes the file, attachment, record history,
and record-trigger effects in one database transaction. An unsuccessful
completion does not publish a file or change the record.

## Attach, detach, replace and reorder

Use ordinary record updates or atomic record transactions to set the attachment
field to the desired ordered ID list:

```sh
saas records update deals <deal-id> --data '{"contracts":["<file-b>","<file-a>"]}'
saas records update deals <deal-id> --data '{"contracts":[]}'
saas records query deals --where '{"contracts":{"has":"<file-id>"}}'
```

Newly attached files must be readable by the actor in the same organization.
Attaching a file shares its bytes with readers of that destination field.
Upload replacement bytes as a new attachment and update the list to retain the
wanted entries. Detaching a file does not delete its bytes or other placements.

## Access and history

Files uploaded into records are private attachments. File-library grants and
listings do not expose them. Metadata, raw content, and download links use the
same authorization: the actor must be able to read a containing record and its
attachment field, or an authorized retained historical snapshot containing it.
An existing standalone library file keeps its explicit library access when it is
also attached to a record.

Attachment changes appear in the ordinary 30-day record history. File references
in retained snapshots keep the bytes protected from deletion and permit
reattachment through normal writes. Current row and field permissions apply to
historical access. A file cannot be deleted while a live attachment or retained
history references it. History cleanup releases expired references.

Deleting unreferenced file bytes requires `delete` on `/files`. That permission
does not grant metadata or content access. It permits cleanup of detached files
after their retained history has expired.

Download links expire after five minutes. Local links recheck access when used;
already issued S3 links remain usable until their expiry. Original file downloads
preserve the uploaded contents and filename.

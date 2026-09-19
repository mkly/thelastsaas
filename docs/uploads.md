# File uploads

Browser links, direct uploads, and base64 uploads support local disk and S3.
The authenticated user needs `write` on `/files` in the active organization.
A browser link permits one file upload without another login and expires after
**five minutes**. Permission and membership are checked again when it is used.
The upload is attributed to the user who requested the link.

- MCP `files_upload_link`: browser URL, upload ID, expiry.
- MCP `files_prepare_upload`: filename, size_bytes, optional mime_type/path;
  returns a PUT URL, headers, upload ID, and expiry.
- MCP `files_complete_upload`: verify size and publish the uploaded file.
- MCP `files_upload_status`: query the upload state and completed file ID.
- MCP `files_upload`: base64 alternative for clients that need it.
- CLI `saas files upload <path>`: prepares, transfers raw bytes, and completes.

REST equivalents under `/v1/orgs/:orgId/files`:
`POST /uploads/link`, `POST /uploads`, `GET /uploads/:id`, and
`POST /uploads/:id/complete`. Existing multipart `POST /` remains supported.
The upload response also includes a capability-authorized completion URL and
headers, for clients that do not use the authenticated REST completion endpoint.
Only send the returned headers to the transfer URL, never the account's API token.

The browser credential is in the URL fragment so it is not sent in access logs
or referrer headers. Treat the entire link as a credential. It grants no read,
list, delete, or organization-management access. Completion is idempotent.
Files do not appear in listings until completion verifies and registers them.

## S3

The browser/CLI uploads to `uploads/<upload-id>` through a presigned PUT URL.
Content length and type are signed. Completion verifies the object size with
HEAD and copies it to the final organization/file key using the observed ETag
as a condition, then removes the temporary object. Replaying the presigned PUT
cannot change the completed file.

Allow browser PUT requests from your application's origin in bucket CORS:

```json
[
  {
    "AllowedOrigins": ["https://app.thelastsaas.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 300
  }
]
```

Use your own application origin for self-hosting. The S3 endpoint must be
reachable by the browser/CLI, not only from the application server. Keep the
bucket private. The server needs GetObject, PutObject, and DeleteObject access
for temporary and final keys. CopyObject uses source read and destination write
permissions. Configure a bucket lifecycle rule to expire the `uploads/` prefix
after one day, so abandoned or replayed temporary uploads are also removed.

## Local storage and cleanup

Local upload URLs stream raw bytes through the server into a temporary file,
enforce the declared size while streaming, and move the file on completion.
Creating an upload also removes up to 50 sessions expired for over an hour and
their temporary objects. Each user can have at most 20 unexpired, unfinished
uploads per organization. Expired links require a new upload session.

The file-upload database migration is required on existing installations.

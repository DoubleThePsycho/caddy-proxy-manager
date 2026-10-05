# Scheduled backups

Feature id `scheduled_backups` (Business edition and up). Code: `ee/backups/`.

On a schedule, the configuration is exported exactly like the free **Export** on the Change history page and uploaded to your own S3-compatible storage: Amazon S3, Cloudflare R2, Backblaze B2, Hetzner Object Storage, Wasabi, MinIO, Ceph and others. Older backups are deleted according to a retention count. A stored backup can be restored from the dashboard, or downloaded from the bucket and loaded with the free import.

Configure it on the **Backups** page (`/backups`, under Change history in the sidebar; it needs `backups:read`) or through `/api/v1/backup-destinations` and `/api/v1/backup-runs`.

## What a backup contains

Each backup is the file `POST /api/v1/config/export` produces (see [config-history.md](config-history.md#export-and-import-community-free)): the configuration as JSON with every secret (certificate and CA private keys, access-list password hashes, DNS provider credentials) encrypted with the destination's **passphrase** (scrypt, AES-256-GCM). Users, sessions, API tokens, sign-in settings, the license and the backup destinations themselves are not part of it.

Only the secrets are encrypted. Host names, upstream addresses and settings are readable by anyone who can read the file, so keep the bucket private and, where the provider offers it, turn on server-side encryption and object versioning or object lock.

Files are stored as `<prefix>/ingressi-config-<time>.json`, the time being the export time in UTC with `:` replaced by `-` (for example `backups/ingressi-config-2026-10-02T03-00-00.123Z.json`), with:

- `Content-Type: application/json`;
- `x-amz-content-sha256` set to the SHA-256 of the file, which is part of the SigV4 signature, so the storage rejects an upload that was corrupted in transit;
- the same SHA-256 as object metadata `x-amz-meta-sha256`, checked again when the dashboard restores the file.

## The passphrase

The passphrase is stored encrypted with this instance's `SESSION_SECRET` key, so that backups run unattended. **Store it in a password manager as well.** Restoring a backup on a new machine (after losing this one, its database or its `SESSION_SECRET`) needs it, and it cannot be recovered from the backup files.

Changing a destination's passphrase applies to new backups only. Older backups keep needing the passphrase they were made with: enter it in the restore dialog (or as `passphrase` in the restore request).

## Destinations

| Field | Notes |
| --- | --- |
| `name` | Up to 100 characters. |
| `enabled` | Disabled destinations make no scheduled backups. |
| `endpoint` | The S3 API origin, `http` or `https`, without path, query or credentials. Examples below. |
| `region` | Default `us-east-1`. `auto` for R2, the location (`fsn1`, `nbg1`, `hel1`) for Hetzner. |
| `bucket` | 3-63 characters. Virtual-hosted addressing needs a DNS-compatible name. |
| `prefix` | Folder of the backup files, e.g. `ingressi/prod`; empty for the bucket root. Letters, digits and `! _ . * ' ( ) -`, segments separated by `/`. |
| `pathStyle` | `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. Required for MinIO, IP-address and single-label endpoints. |
| `accessKeyId` | Shown in the dashboard and the API. |
| `secretAccessKey` | Write-only, stored encrypted, never returned (`hasSecretAccessKey`). Must be entered again when the endpoint changes. |
| `passphrase` | Write-only, at least 12 characters, stored encrypted, never returned (`hasPassphrase`). |
| `schedule` | `{ "kind": "hourly", "minute": 0-59 }`, `{ "kind": "daily", "time": "HH:MM" }` or `{ "kind": "weekly", "day": "monday", "time": "HH:MM" }`. Default daily at 03:00. |
| `timeZone` | IANA time zone the schedule is read in, default `UTC`. |
| `retention` | Backups to keep, 1-1000, default 30. |

Endpoint examples:

| Provider | Endpoint | Region | Path-style |
| --- | --- | --- | --- |
| Amazon S3 | `https://s3.eu-central-1.amazonaws.com` | `eu-central-1` | no |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | yes |
| Backblaze B2 | `https://s3.eu-central-003.backblazeb2.com` | `eu-central-003` | no |
| Hetzner Object Storage | `https://fsn1.your-objectstorage.com` | `fsn1` | no |
| Wasabi | `https://s3.eu-central-1.wasabisys.com` | `eu-central-1` | no |
| MinIO | `http://minio:9000` | `us-east-1` | yes |

The key needs permission to put, get, list and delete objects under the prefix (for AWS: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::<bucket>/<prefix>/*` and `s3:ListBucket` on the bucket, limited with an `s3:prefix` condition if you like).

**Test connection** writes a small object (`<prefix>/ingressi-connection-test-<random>.txt`), reads it back, deletes it and reports which step failed.

Deleting a destination deletes its run history. The backup files in the bucket are never deleted by that.

## Schedule and runs

A job started from `src/instrumentation.ts` (never in tests) runs every minute and backs up every enabled destination whose next run is due, one destination after the other. It runs in the dashboard's process and does not block other jobs: key derivation (scrypt) and network I/O are asynchronous.

- Times are wall-clock times in the destination's time zone. When a daily or weekly time does not exist because clocks spring forward, the backup runs right after the gap (02:30 becomes 03:30); when it occurs twice because clocks fall back, it runs once, the first time. Hourly backups run every real hour: none in the skipped hour, two in the repeated one.
- A destination never has two backups at once, also with several replicas on one PostgreSQL database: "Back up now" answers 409 while a backup to it runs, and the scheduler skips it. Backups that were running when their process stopped are marked failed ("Interrupted") at the next start, or by the scheduler within a minute once no process holds the destination.
- A failed backup is retried after 5 minutes, then 10, 20, 40, ... up to 6 hours, but never later than the next scheduled time. A success resets this. The destination shows the last result, the error and the number of failures in a row; each attempt is listed under **Recent backups** (`GET /api/v1/backup-runs`). The newest 200 runs per destination are kept.
- After a successful upload, backup files under the prefix beyond the retention are deleted, oldest first (at most 100 per run). Only files named like backups directly under the prefix are considered; other objects, and backups in sub-folders, are never touched. If this step fails, the run still counts as successful and carries a warning.
- A run has a status `success` or `failed`, the object key, size, SHA-256, the number of older backups deleted, and the error or warning.

Errors stored and shown name the HTTP status and the S3 error code (for example `HTTP 403 (AccessDenied) from the storage: ...`) or the network error code. Credentials, signatures, response bodies and URLs are never stored, shown or logged.

## Restore

**Backups → Restore** (or `GET .../objects` then `POST .../restore { "key": ... }`) downloads the chosen backup, checks its SHA-256 against `x-amz-meta-sha256`, and imports it through the same code as `POST /api/v1/config/import`:

- the file is validated and the passphrase checked before anything changes (a wrong passphrase is a 400);
- when configuration history is on, the configuration being replaced is saved as a snapshot (reason `import`) in the same transaction;
- the result is applied to Caddy; if Caddy rejects it, the previous configuration is put back and the answer is 502;
- like an import, it is refused (409) when it would create, change or delete a host that an enabled change approval policy protects ([change-approvals.md](change-approvals.md)).

The destination's passphrase is used unless the request gives one. Restore is refused on a sync slave (409).

To restore without a license or on a fresh installation: download the file from the bucket with your provider's tools and use **Export or import** on the Change history page (free), with the passphrase from your password manager.

## Storage access

`ee/backups/s3.ts` is a small S3 client (PUT object, GET object, ListObjectsV2, DELETE object) with AWS Signature Version 4 implemented with `node:crypto` (`ee/backups/sigv4.ts`, tested against AWS's published examples). There is no AWS SDK dependency. Requests never follow redirects (a 301/307 from the storage is an error that suggests checking the endpoint, region and addressing) and time out after 30 seconds (5 minutes for uploading or downloading a backup file). Downloads are limited to 50 MiB, the import limit.

## API

All endpoints are admin-only, documented in the OpenAPI spec (tag "Backups") and audited.

| Method and path | What | License |
| --- | --- | --- |
| `GET /api/v1/backup-destinations` | List destinations (no secrets) | no |
| `POST /api/v1/backup-destinations` | Create | yes |
| `GET /api/v1/backup-destinations/{id}` | Get | no |
| `PUT /api/v1/backup-destinations/{id}` | Update; omitted fields and empty secrets keep their values | yes, unless the body only disables it |
| `DELETE /api/v1/backup-destinations/{id}` | Delete (bucket files are kept) | no |
| `POST /api/v1/backup-destinations/{id}/test` | Connection test `{ok, error, failedStep, durationMs}` | yes |
| `POST /api/v1/backup-destinations/{id}/run` | Back up now; returns the run (a failed upload is `status: "failed"`) | yes |
| `GET /api/v1/backup-destinations/{id}/objects` | Stored backups, newest first; 502 if the storage fails | no |
| `POST /api/v1/backup-destinations/{id}/restore` `{key, passphrase?}` | Restore a stored backup | yes |
| `GET /api/v1/backup-runs?page&per_page&destination_id` | Run history, newest first | no |

Audit actions: `backup_destination_created`, `backup_destination_updated`, `backup_destination_deleted`, `backup_destination_tested`, `backup_run_manual`, `config_backup_restored`, `config_backup_restore_failed` (plus `config_imported` from the import a restore performs). Scheduled runs are recorded in the run history, not in the audit log.

## Alerts

The alert rule type `backup_failed` (see [alerting.md](alerting.md)) fires for each enabled destination whose backups failed `minFailures` times in a row (default 1) and resolves after the next successful backup.

## Licensing behaviour

- Creating a destination, changing one, turning one on, **Back up now**, **Test connection** and restore need a license that includes `scheduled_backups` (Business and up, active or in its grace period).
- Turning a destination off and deleting it never need one; neither do viewing destinations, runs and stored backups.
- Scheduled backups of destinations that are already enabled keep running when the license lapses: the scheduler never checks it.

## Instance sync and data

Destinations and runs (tables `backup_destinations` and `backup_runs`, migration `0029_scheduled_backups`) are master-only: they are not part of the configuration, not in exports, snapshots or backups, and not synced to slaves. Creating a destination on a sync slave is refused (409), and a backup on a slave fails, because a slave's configuration comes from its master: back up the master. The secret access key and the passphrase are re-encrypted by the startup `SESSION_SECRET` rotation pass like every other stored secret.

## Known limitations

- Static access keys only: no IAM roles, session tokens or instance metadata credentials.
- Uploads are single `PUT` requests (S3 allows up to 5 GiB; backups are limited to the 50 MiB import size).
- Retention counts files; it does not look at age. Use a lifecycle rule in the bucket for age-based expiry or as a second line of defence.
- Runs are only as frequent as the scheduler tick (one minute) and run in the dashboard process; if the dashboard is down at the scheduled time, the backup runs once when it is back.

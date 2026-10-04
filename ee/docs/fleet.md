# Fleet management

Feature id `fleet`, included in the **Enterprise** edition. Code: `ee/fleet/` (Elastic License 2.0). The sync protocol additions it relies on (fingerprints, the slave's status reply, pushing one payload to one slave) are MIT: `src/lib/instance-sync-fingerprint.ts`, `src/lib/instance-sync-status.ts`, `src/lib/instance-sync.ts`.

For platform teams that run several nodes. A master instance already pushes its whole configuration to its slaves on every change. Fleet management adds, on top of that push:

- **Environments**: named groups of slaves in a promotion order, for example staging, then production.
- **Promotion**: an environment can be set to receive configuration only by promotion. It then stays on a pinned revision until someone promotes the revision the environment before it runs.
- **Canary rollout**: a promotion goes to one instance first, which is watched for a while before the rest follow. A failed check stops the rollout.
- **Drift detection**: the master asks each slave which configuration it runs and shows the ones that differ from what it pushed.
- **Pull replicas**: slaves the master cannot reach (behind NAT or a strict firewall) poll the master for their configuration instead. They join environments, rollouts and drift detection like any instance (see [Pull replicas](#pull-replicas)).

Everything is on the **Fleet** page and under `/api/v1/fleet`. It works in master mode with slaves added in the dashboard (Settings → Instance Sync) and pull replicas; slaves configured with `INSTANCE_SLAVES` keep syncing as before and cannot join an environment.

## The Fleet page

- **Environments** in promotion order, each with its promotion rule (every change, or promotion only and the revision it is pinned to), its canary settings, its nodes and its rollout. Each environment has the anchor `#environment-<id>`, which the sidebar's environment switcher links to.
- A **rollout panel** for each running rollout: the canary, the observation with its countdown, the rest and the pin, what the revision changes against the one it replaces, and where each target stands. Aborting asks for a confirmation in place.
- **Nodes**: the master and every replica, with how it syncs (pushed, or a pull agent with its poll interval), the release it reported, what it runs against its environment ("behind its environment", "ahead" for a canary), its last sync, its health, its drift and its certificate storage. A drifted node, or one behind its environment, shows **Re-sync**; the row menu re-syncs and moves a node to another environment.
- **Recent rollouts** with who started them, **pull replicas** and **revisions** with their diffs.

Certificate storage per node is what the configuration it last received sets (the master's own setting for nodes that receive every change, the revision's setting for pinned nodes): the backend and Redis mode only, never addresses or secrets.

## How syncing changes

| Instance | What it receives |
| --- | --- |
| No environment | Every change at once, exactly as before. |
| In an environment without promotion-only | Every change at once, exactly as before. The environment is a group and a promotion source. |
| In a promotion-only environment | Nothing from plain syncs (every change, **Sync now**, `INSTANCE_SYNC_INTERVAL`). It receives its environment's revision through rollouts and re-syncs only. |
| A pull replica | The same as a pushed instance in its place, fetched with its next poll instead of pushed (see [Pull replicas](#pull-replicas)). |

`syncInstances()` leaves instances of promotion-only environments out (they are not counted in its result either), and skips an `INSTANCE_SLAVES` entry with the URL of such an instance (logged once), which would otherwise push every change past the promotion. These checks never look at the license: environments keep working as configured when a license lapses.

An instance that joins a promotion-only environment keeps the configuration it has until the next promotion or a re-sync. An instance that leaves one (or whose environment turns promotion-only off, or is deleted) gets the master's configuration with the next change or **Sync now**. Neither change pushes anything by itself.

## Revisions

A revision is a stored configuration an environment can be pinned to. Configuration history snapshots ([config-history.md](config-history.md)) do not fit this role: recording can be off, and retention deletes old snapshots, also one that production still runs. So a promotion captures the master's configuration as a fleet revision, reusing the newest revision with the same fingerprint.

Revisions use the snapshot format of `src/lib/config-content.ts` and config history's fingerprint and diff code, limited to what instance sync sends: certificates, CA certificates, client certificates, access lists and their users, proxy hosts, L4 proxy hosts and the settings groups. Attribution columns and CA signing keys are left out (sync never sends them). Secrets stay encrypted with the master's `SESSION_SECRET`, as in snapshots; like snapshots, revisions rely on `SESSION_SECRET_PREVIOUS` after a rotation. Hosts with API monetization on are filtered out when a revision is pushed, as for every sync, by their state at that moment; while the master serves them on replicas, they go with the gate's index of that moment instead ([API monetization](api-monetization.md#sync-replicas-and-pull-replicas)).

White-label branding ([white-label.md](white-label.md)) is not configuration and is not part of a revision: every push, a promotion included, carries the master's current branding.

The newest 100 revisions are kept, and any older one that an environment, an instance or a kept rollout still refers to. The newest 500 finished rollouts are kept.

## Promotion

Environments are ordered by `position` (then by id). A promotion into a promotion-only environment takes:

- for the first environment: the master's current configuration;
- otherwise what the environment before it runs: its pinned revision when it is promotion-only, the master's current configuration when it receives every change.

So a revision moves through the environments in order, and nothing reaches production that staging did not run. **Preview** (`GET /api/v1/fleet/promotions/preview?environmentId=`) shows the source, the diff against the revision the environment is pinned to (secrets only as "changed"), the instances and warnings (for example a staging instance whose last sync failed). Starting a promotion is refused while another rollout runs in the environment, and when the environment and all its enabled instances already run that revision.

### Rollouts

A rollout pushes one revision to the enabled instances of one environment:

1. **Canary** (when enabled; default for new environments): the revision goes to one instance (the one chosen, or the enabled instance with the lowest id).
2. **Observing**: for `waitSeconds` (default 300, at most 24 h) the canary is checked on every step: its health endpoint (`GET /api/health` must answer `{"status":"ok"}`) and, with `checkCaddyStatus`, its status reply: Caddy's last apply must have succeeded, it must still run the pushed fingerprint and have no local changes. A slave on an older release cannot report a status, so the Caddy status check fails for it; turn the check off for such a canary.
3. **Rolling**: the revision goes to the other instances, four at a time.
4. The environment is pinned to the revision once every target took it.

Any failed push or check stops the rollout and marks it **failed**: instances it had not reached stay on the previous revision (their targets show as skipped) and so does the environment. The canary keeps what it received. One failed check is enough; there is no retry.

Rollouts advance in the fleet scheduler (`ee/fleet/scheduler.ts`): a step every 10 seconds, and right after a rollout starts. Their whole state is in the database (`fleet_rollouts`, `fleet_rollout_targets`), so a restart picks a rollout up where it was. A push that a restart cut off is sent again: the target was still pending, and pushing the same revision twice is harmless. Pushes use `syncInstanceWithPayload`, the same code as every sync, with sealed secrets, key pinning, the token checks, no redirects and the sync timeout.

**Abort** stops a running rollout. A push in progress completes; nothing else is pushed. **Rollback** promotes the revision the environment ran before a rollout (its `fromRevisionId`), without a canary unless asked. It is only offered for the latest rollout of an environment once it stopped, so it also undoes a failed rollout's canary.

### Re-sync

**Re-sync** pushes to one instance what it should run: its promotion-only environment's revision, or the master's configuration. It is the manual repair for a drifted instance; drift is never repaired automatically. Refused while a rollout runs in the instance's environment.

## Drift detection

After a successful push the master records, per instance, the revision (or "live configuration") and the push's **sync fingerprint**. When a slave applies a sync (and Caddy accepted it), it records the payload's fingerprint, and a digest of its own stored copy of the synced configuration.

Both fingerprints cover the same content: the settings groups and tables of the sync payload, with secrets in plaintext, without `createdAt`/`updatedAt`, rows sorted by id, serialized with sorted keys. They are HMAC-SHA256 values keyed with a key derived (HKDF) from the slave's sync token, which only the master and that slave hold, so a fingerprint cannot be used to test a guess of a secret. Master and slave agree whatever release each runs, as both hash the payload as sent.

Every 5 minutes, once at least one environment exists, and on **Check drift now**, the master asks each enabled instance `GET /api/instances/sync?status=1` (a pull replica is not asked: its last report, sent with every poll, stands in for the reply, and it is *unreachable* when it has not checked in for 3 poll intervals). The request is authenticated with the sync token like the sync itself, uses its own rate limit on the slave, issues no nonce, follows no redirects, and is bounded to 15 s and 64 KiB. The slave answers:

```json
{
  "syncStatus": {
    "version": 1,
    "appVersion": "2.3.0",
    "fingerprint": "<64 hex characters, or null>",
    "appliedAt": "2026-10-03T08:00:00.000Z",
    "localChanges": false,
    "overriddenSettings": ["general"],
    "lastSync": { "at": "2026-10-03T08:00:00.000Z", "error": null },
    "caddy": { "ok": true, "at": "2026-10-03T08:00:01.000Z", "code": null }
  }
}
```

| Status | Meaning |
| --- | --- |
| In sync | It runs the fingerprint of the last push and its synced configuration was not changed there. |
| Drifted | It runs another configuration (another master pushed, or a push that seemed to fail did apply), or its synced configuration changed since the last sync it applied (edited on the instance, or a sync whose Caddy apply failed there). |
| Unreachable | The status request failed (network, timeout, HTTP error, token refused, invalid reply). |
| Older version | The slave runs a release without the status reply: it answers 405 (no key endpoint) or with its sync key. Its configuration is unknown; that is not an error. |
| Unknown | Nothing to compare: nothing was pushed since fleet tracking started, or the slave recorded no sync since it was upgraded. A re-sync starts tracking. |

A slave that was upgraded, or given another token, since its last sync reports local changes as unknown (`null`) instead of guessing. Settings a slave overrides with its own value (`overriddenSettings` in its reply) are not drift: they are a slave feature. A successful push counts as in sync until the next check.

## Alerts

With alerting ([alerting.md](alerting.md)), two rule types watch the fleet: `fleet_drift` (one alert per drifted instance) and `fleet_rollout_failed` (one per environment whose latest rollout failed). Rollout failures and successes are also in the audit log.

## Permissions

| Permission | Allows |
| --- | --- |
| `fleet:read` | The Fleet page, environments, instances with their revision and drift, revisions and their diffs, promotion previews, rollouts, pull replicas. |
| `fleet:write` | Creating, changing and deleting environments, assigning instances, **Check drift now**. |
| `fleet:promote` | Starting promotions and rollbacks, aborting rollouts, re-syncing instances. |
| `fleet:replicas` | Adding and deleting pull replicas, issuing, rotating and revoking their credentials. Administrator-level. |

Promotion changes what production serves, so it has its own permission: a release manager can hold `fleet:promote` without restructuring environments. For the same reason, anything that releases instances from promotion needs `fleet:promote` as well as `fleet:write`: turning promotion-only off for an environment with instances, taking an instance out of a promotion-only environment (to none, or to one that receives every change) and deleting a promotion-only environment with instances. Otherwise `403`. Plain **Sync now** (`instances:write`) never reaches promotion-only instances.

`fleet:write`, `fleet:promote` and `fleet:replicas` act on the configuration of every host at once, so a role with a tag scope cannot hold them. `fleet:write` and `fleet:promote` are not administrator-level: they move configuration that others already wrote, never introduce new content, and cannot point a sync at another URL (that is `instances:write`, which is administrator-level). `fleet:replicas` is administrator-level for the same reason as `instances:write`: a pull credential fetches the whole configuration.

## License

| Action | License |
| --- | --- |
| Create an environment, change one, assign an instance to one | `fleet` required (`403` otherwise) |
| Start a promotion or a rollback | required |
| Delete an environment, turn promotion-only off (`{"promotionOnly": false}` alone), take an instance out | never |
| Abort a rollout, re-sync an instance, check drift | never |
| Add a pull replica, rotate (or issue again) its credential | required |
| Revoke a pull replica's credential, delete a pull replica | never |
| Plain syncs skipping promotion-only instances, running rollouts, drift checks in the background, pull replicas polling | never: configured environments and replicas keep working when the license lapses |
| Reading anything | never |

## API

All under `/api/v1/fleet`, with Bearer token or session auth, documented in the OpenAPI spec (tag "Fleet") and audited.

| Method and path | Permission | What |
| --- | --- | --- |
| `GET /api/v1/fleet` | `fleet:read` | Overview: mode, the master (release, certificate storage, drift and rollout intervals), environments, instances, newest revisions and rollouts (with who started them), and the certificate storage of the revisions shown |
| `GET /api/v1/fleet/environments` | `fleet:read` | Environments in promotion order |
| `POST /api/v1/fleet/environments` | `fleet:write` | `{name, description?, position?, promotionOnly?, canary?: {enabled?, waitSeconds?, checkCaddyStatus?}}`; license; `201` |
| `GET /api/v1/fleet/environments/{id}` | `fleet:read` | |
| `PATCH /api/v1/fleet/environments/{id}` | `fleet:write` | Partial update; license unless only `{"promotionOnly": false}` |
| `DELETE /api/v1/fleet/environments/{id}` | `fleet:write` | `204`; no license |
| `GET /api/v1/fleet/instances` | `fleet:read` | Instances with environment, revision and drift |
| `PUT /api/v1/fleet/instances/{id}/environment` | `fleet:write` | `{environmentId}` or `{environmentId: null}` |
| `POST /api/v1/fleet/instances/{id}/resync` | `fleet:promote` | `{ok, error, revisionId, instance}` |
| `GET /api/v1/fleet/drift` | `fleet:read` | Instances with their drift as of the last check |
| `POST /api/v1/fleet/drift` | `fleet:write` | Check every enabled instance now |
| `GET /api/v1/fleet/revisions?limit&offset` | `fleet:read` | Revisions without content |
| `GET /api/v1/fleet/revisions/{id}` | `fleet:read` | |
| `GET /api/v1/fleet/revisions/{id}/diff?against=previous\|current\|<id>` | `fleet:read` | Diff; secrets only as `{"path": ..., "secret": true}` |
| `GET /api/v1/fleet/promotions/preview?environmentId=` | `fleet:read` | The pending promotion: source, diff, targets, warnings |
| `GET /api/v1/fleet/rollouts?environmentId&limit&offset` | `fleet:read` | Rollouts with their targets |
| `POST /api/v1/fleet/rollouts` | `fleet:promote` | Start a promotion: `{environmentId, canary?}` (`canary: false` for none); license; `201` |
| `GET /api/v1/fleet/rollouts/{id}` | `fleet:read` | Status |
| `POST /api/v1/fleet/rollouts/{id}/abort` | `fleet:promote` | No license |
| `POST /api/v1/fleet/rollouts/{id}/rollback` | `fleet:promote` | Optional `{canary}`; license; `201` |
| `GET /api/v1/fleet/pull-replicas` | `fleet:read` | Pull replicas with last check-in, key pin and credential prefix |
| `POST /api/v1/fleet/pull-replicas` | `fleet:replicas` | `{name, enabled?, syncPublicKey?}`; license; `201` with `{replica, credential, env}` (shown once) |
| `GET /api/v1/fleet/pull-replicas/{id}` | `fleet:read` | |
| `DELETE /api/v1/fleet/pull-replicas/{id}` | `fleet:replicas` | `204`; no license |
| `POST /api/v1/fleet/pull-replicas/{id}/credential` | `fleet:replicas` | Rotate (or issue after a revocation): `{replica, credential, env}`; license |
| `DELETE /api/v1/fleet/pull-replicas/{id}/credential` | `fleet:replicas` | Revoke; no license |

```bash
# staging receives every change; production only promotions, canary first for 10 minutes
curl -X POST https://dash.example.com/api/v1/fleet/environments -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"staging"}'
curl -X POST https://dash.example.com/api/v1/fleet/environments -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"production","promotionOnly":true,"canary":{"waitSeconds":600}}'
curl -X PUT https://dash.example.com/api/v1/fleet/instances/3/environment -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"environmentId":2}'
# what would change, then promote staging's configuration to production
curl "https://dash.example.com/api/v1/fleet/promotions/preview?environmentId=2" -H "Authorization: Bearer $TOKEN"
curl -X POST https://dash.example.com/api/v1/fleet/rollouts -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"environmentId":2}'
```

## Security notes

- Every push, canary included, goes through the existing sync code: the slave's key is fetched and checked against its pin, secrets are sealed to it with its single-use nonce, the token is checked against the token policy, plain HTTP needs `INSTANCE_SYNC_ALLOW_HTTP`, redirects are not followed and requests are bounded in time. Revisions add no new way for configuration to leave the master.
- The status request is authenticated with the sync token and answered only in slave mode; it carries no secret (the fingerprints are keyed HMACs) and its fields are validated strictly by the master. Error messages stored and shown are fixed strings.
- The health check sends no token.
- Revisions keep secrets encrypted at rest and are never returned with their content; diffs mask secrets like configuration history.
- A slave stores its applied-sync record under the settings key `instance_sync_applied`; it is not part of the configuration (not exported, snapshotted or synced).

## Data

Migration `0038_fleet`: `fleet_environments`, `fleet_instances` (environment, last push, drift), `fleet_revisions`, `fleet_rollouts`, `fleet_rollout_targets`. Migration `0040_fleet_pull`: `instances.syncMode` (`push` or `pull`), `fleet_rollout_targets.requestedAt`, and `fleet_pull_replicas` (credential hash and prefix, the encrypted fingerprint token, last check-in and report, what was last sent, a pending re-sync). Master-only: none of it is synced to slaves or part of configuration export or history. Foreign keys are not enforced; deleting an instance removes its fleet and pull rows and skips its pending rollout targets, deleting an environment removes its rollouts.

## Limits

- Only slaves added in the dashboard can join an environment; `INSTANCE_SLAVES` entries receive every change as before.
- One rollout per environment at a time. Rollouts are not scheduled or approved; they start when someone starts them.
- Health checks are the slave's health endpoint and, optionally, its Caddy apply status. Traffic-based checks (error rates from analytics) are not part of it yet.
- A failed check fails the rollout at once.
- A pull replica learns of a change with its next poll, so it lags by up to its poll interval (plus a few seconds the master shares one built payload between polls). Rollouts wait for it (up to `INSTANCE_PULL_APPLY_TIMEOUT`).

## Pull replicas

A pull replica is a slave that fetches its configuration from the master instead of being pushed to: for nodes behind NAT, or in networks the master must not reach. On the master it is an instance with mode `pull`; it can join environments, take part in rollouts (canary included), report drift and be re-synced like any instance. Code: `ee/fleet/pull-replicas.ts` (management), `ee/fleet/pull-server.ts` (the master's endpoint), `ee/fleet/pull-agent.ts` (the replica); the shared protocol pieces are MIT (`ee/fleet/pull-config.ts`, `instance-sync-validation.ts`, `instance-sync-apply.ts`).

### Setting one up

1. On the master: **Fleet → Pull replicas → Add pull replica** (also under Settings → Instance Sync), or `POST /api/v1/fleet/pull-replicas` with `{"name": "branch-office"}`. The reply shows the replica's credential and the environment variables it needs, once. The master keeps only the credential's SHA-256.
2. Optionally paste the replica's sync public key (its own Settings → Instance Sync page shows it) as `syncPublicKey`: the key is pinned at once. Otherwise the first key the replica proves is pinned (trust on first use, as for pushed slaves).
3. On the replica, set the variables and restart it:

```bash
INSTANCE_MODE=slave
INSTANCE_SYNC_MODE=pull
INSTANCE_MASTER_URL=https://dash.example.com
INSTANCE_PULL_TOKEN=pull_…
# INSTANCE_PULL_INTERVAL=30
```

The replica keeps its own `SESSION_SECRET`. Its Settings → Instance Sync page shows where it polls, its last check-in and the last error.

| Variable | Where | Meaning |
| --- | --- | --- |
| `INSTANCE_SYNC_MODE` | replica | `pull` makes a slave poll; anything else (default `push`) keeps it pushed to. A pull replica refuses pushes (`403` on `/api/instances/sync`). |
| `INSTANCE_MASTER_URL` | replica | The master's base URL. `https` only; `http` needs `INSTANCE_SYNC_ALLOW_HTTP=true`. No credentials, query or fragment. |
| `INSTANCE_PULL_TOKEN` | replica | The credential (`pull_` and 43 characters). |
| `INSTANCE_PULL_INTERVAL` | replica | Seconds between polls, default 30 (10 to 3600), with ±20% jitter. |
| `INSTANCE_SYNC_TIMEOUT_MS`, `INSTANCE_SYNC_MAX_BYTES` | replica | Time limit of a poll and the largest reply read, as for pushes. |
| `INSTANCE_PULL_APPLY_TIMEOUT` | master | Seconds a rollout waits for a pull replica to confirm a revision, default 600 (60 to 86400), never less than three of its poll intervals. |
| `INSTANCE_PULL_RATE_MAX`, `INSTANCE_PULL_RATE_WINDOW_MS` | master | Polls per client address and window (default 300 per minute; replicas behind one NAT share it). |
| `INSTANCE_PULL_REPLICA_RATE_MAX` | master | Polls per replica and minute (default 30). |

### How a poll works

The replica polls `POST /api/instances/pull` (outside `/api/v1`; the proxy middleware lets it through and the route authenticates). The body carries its sync key exactly as a pushed slave serves it (public key, a fresh single-use nonce, proofs), the challenge from the master's previous reply, its poll interval and its status report (the body of `GET /api/instances/sync?status=1`: the fingerprint it runs, local changes, Caddy's last apply, its release) with its health.

1. The credential is looked up by its hash. Unknown or revoked: `401`. A disabled replica: `403` "This pull replica is disabled on the master". Not a master: `403`.
2. The replica must prove it holds the private key of the key it presents, for a single-use challenge the master issued (the rotation proof of `sync-crypto.ts`, made with the current key). Without a valid proof the reply is `401` with a fresh challenge, and the replica polls again at once. Challenges live in the master's memory: after a restart a replica needs one more round trip.
3. The key is checked against the replica's pin exactly as a push checks a slave's: pinned on first contact, re-pinned only with a rotation proof from the pinned key (`SESSION_SECRET_PREVIOUS` on the replica; a pull replica proves at most 7 previous secrets, one proof slot being its current key's), refused otherwise with `409` (recorded as *"Slave sync key changed…"*). The pin is kept in the same store as push pins, under the replica's identity (`pull:` and a random id, its stored base URL), so **Key pin** and the pin API work for it.
4. The check-in and the report are recorded.
5. The master works out what the replica should run: outside a promotion-only environment, its current configuration; inside one, the revision a running rollout asked it to take, else a pending re-sync's, else the revision it last confirmed, else nothing (it keeps what it has, as a pushed instance that joins does).
6. When the replica reports that configuration's fingerprint (and its Caddy took it), the reply is `{"changed": false}`, and the master records the report as a successful push when it tells something new (another configuration, a rollout waiting for it, a re-sync, an earlier failure). Otherwise the reply carries the payload, sealed to the presented key with the replica's nonce: the same sealing code, the same payload and the same validation as a push.

The replica applies a payload through the same code as a pushed sync (validation, sealed secrets opened, stored, Caddy applied, fingerprint recorded) and polls again at once to report. It refuses a payload not sealed to its key with this poll's nonce. Requests follow no redirects and are bounded in time and size; failures back off exponentially up to 15 minutes. The master shares one built payload between polls a few seconds apart.

Fingerprints are keyed as for pushed slaves, with a token derived from the credential (HKDF), which the master keeps encrypted instead of the credential. Rotating the credential re-keys them, so the replica receives its configuration once more.

### Rollouts, drift and re-sync

- **Rollouts**: a step marks a pull target as requested (`requestedAt`); the replica takes the revision with its next poll. The target is synced once the replica reports it runs the revision (and Caddy accepted it), failed when it reports it could not apply it, or failed when it has not confirmed it by `INSTANCE_PULL_APPLY_TIMEOUT`. A rollout overwrites changes made on the replica, as a push would. Canary checks read the replica's reports: it must keep checking in and report itself healthy, and with the Caddy status check, a successful Caddy apply, the promoted fingerprint and no local changes. Abort and failure leave a requested replica that has not confirmed the revision on the one it last confirmed; a canary that confirmed keeps it, like a pushed canary. Everything is in the database, so a restart picks the rollout up.
- **Drift** for a pull replica uses its last report instead of a status request. *Unreachable* means it has not checked in for 3 poll intervals; *unknown*, that it has not checked in yet.
- **Re-sync** asks the replica to take what it should run with its next poll, even when it reports it runs it (`{"pending": true}` in the reply); it counts once the replica confirms it.
- **Sync now** and `INSTANCE_SYNC_INTERVAL` never reach pull replicas; they poll.

### Credentials

- **Rotate** (`POST …/credential`): a new credential; the old one stops working at once. The key pin stays. Also issues a credential after a revocation. Needs the license.
- **Revoke** (`DELETE …/credential`): polls are refused (`401`) until a new credential is issued. The replica, its pin and history stay; reset the pin separately if the replica itself is suspect. No license.
- **Delete**: removes the instance with its credential, pin and fleet records. No license. The replica keeps the configuration it has.

All of these, key pins and re-syncs are audited (`fleet_pull_replica_created`, `fleet_pull_credential_rotated`, `fleet_pull_credential_revoked`, `fleet_pull_replica_deleted`, `instance_sync_key_pinned`).

### Security notes

- **A stolen credential** gets nothing without the replica's private sync key (derived from its `SESSION_SECRET`): every poll must prove that key for a fresh single-use challenge, and the key must be the pinned one. So a thief can neither read the configuration (not even its non-secret parts) nor send reports or check-ins in the replica's name. A thief who also holds the replica's `SESSION_SECRET` is the replica; revoke the credential and reset the pin. Before first contact, whoever uses the credential first pins its key: pin the replica's key when adding it to close that window.
- **A replica impersonating another**: a credential names exactly one replica (the master looks it up by hash; the request carries no instance id), and each replica's key is pinned on its own. Replica B configured with A's credential presents B's key, which is not A's pin: `409`, nothing sent.
- **Replay of a pull reply**: secrets are sealed to the replica's key and bound to the nonce the replica issued for that poll, and the replica applies only a payload sealed for the poll it just sent. A recorded reply carries another poll's nonce (used up if it was applied): it is refused and nothing is written. A replayed request fails the single-use challenge.
- **A man in the middle without TLS** (`INSTANCE_SYNC_ALLOW_HTTP`): he sees the credential and the non-secret configuration, and could answer the replica as the master and inject configuration, as with an HTTP push. He cannot open sealed secrets, nor reuse the credential from another machine without the replica's key. The master URL must therefore be https unless explicitly allowed; redirects are never followed.
- Configuration sent to a replica passes the same validation as a push (proxy host content, reserved L4 ports). The replica never logs the credential or the master's reply; the master's errors are fixed strings.
- Pull replicas have their own rate limits on the master, before and after authentication.
- A replica whose `SESSION_SECRET` is one of the public placeholders (the development fallback) cannot prove its key, since anybody could; it does not poll and says so on its Settings page.

### Compared with the earlier plan

This section replaces the planned "pull-mode agents". What changed:

- No separate enrolment code and agent id: the credential itself is the enrolment, issued when the replica is added and shown once. The replica is a slave (`INSTANCE_MODE=slave`) with `INSTANCE_SYNC_MODE=pull`, not a new `INSTANCE_MODE=agent`.
- The endpoint is `POST /api/instances/pull` (next to `/api/instances/sync`, with its own rate limits) rather than under `/api/v1`, which is for dashboard users and API tokens.
- No master signing key: the master's authenticity rests on TLS, as for pushes. Instead every poll proves the replica's key (so a stolen credential alone gets nothing) and every payload is sealed with the replica's own single-use nonce (so a reply cannot be replayed), using the existing sealing and proof code only.
- The report travels with the next poll, which follows at once after an apply; there is no separate acknowledgement call.
- Revoking a credential keeps the key pin (resetting it is a separate, deliberate step).

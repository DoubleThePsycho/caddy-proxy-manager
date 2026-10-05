# The database layer

Ingressi runs on SQLite or PostgreSQL. Code that touches the database is
written once, against an asynchronous, dialect-neutral API. This file is how
to write that code.

## Modules

| Module | What it is |
| --- | --- |
| `src/lib/db.ts` | The facade: `appDb` (asynchronous; also the default export), `sqlite`, `nowIso`, `toIso`, `restrictDatabaseFileModes`, `purgeDeletedDatabaseContent`, `schema`. The synchronous Drizzle instance is internal to `sqlite.ts` (migrations and legacy repairs). |
| `schema.sqlite.ts` | The tables, authored for SQLite. Add tables and columns here, classify every new integer column in `pg-column-types.ts`, then run `bun run db:generate-pg-schema`. |
| `schema.ts`, `schema.pg.ts` | Generated from `schema.sqlite.ts` (`bun run db:check-pg-schema` fails when stale): the switch every importer uses, and the PostgreSQL tables. |
| `references.ts` | `referencesTo(table)`: the foreign keys declared in the SQLite schema (PostgreSQL has none; models delete dependants themselves). |
| `dialect.ts` | `getDialect()`: `postgres` for a `postgres://` or `postgresql://` `DATABASE_URL` or `DATABASE_DIALECT=postgres`, otherwise `sqlite`. |
| `types.ts` | `AppDb`, `AppTx`, `DbExecutor`, `DbReader`, `DbWriter`, `TransactionOptions`. |
| `executor.ts` | `appDb` on the configured dialect, the SQLite executor (transactions, the gate), `outsideTransaction`, `inTransaction`. |
| `executor-core.ts` | What both executors share: the ambient transaction context, frames, the FIFO lock, escaped-query detection, the watchdog. |
| `pg-executor.ts` | The PostgreSQL executor: Drizzle's node-postgres driver, one pooled connection per transaction, the write lock. |
| `postgres.ts` | The PostgreSQL pool: `DATABASE_URL` (with libpq's `sslmode`), `DATABASE_SSL_CA_FILE`, `DATABASE_POOL_MAX`, per-session settings and type parsers. |
| `pg-startup.ts` | PostgreSQL start-up: version and collation checks, migrations (`drizzle-pg/`) under an advisory lock, the refusal of a newer schema. |
| `sqlite.ts` | Opening the SQLite file, PRAGMAs, file modes, schema migrations and legacy repairs (synchronous, at module load), and the statement runner. Inert on PostgreSQL. |
| `ops.ts` | Helpers whose SQL differs between dialects, raw SQL and error classification. |
| `locks.ts` | Cluster locks: `withClusterLock`, `tryWithClusterLock`, `withCoalescedClusterLock` (see below). |
| `startup.ts` | `runDatabaseStartup()` (the one-time data migrations; `register()` in `src/instrumentation.ts` runs it before any job) and `purgeDeletedDatabaseContent()`. |
| `auth-database.ts` | Better Auth's database: Kysely over the application's executor, on either dialect, so Better Auth's queries and transactions are the application's (see below). |
| `kysely-iso-dates.ts` | The Kysely plugin Better Auth's database uses on PostgreSQL: Date parameters as ISO 8601 text, Better Auth's date fields read back as Dates. |
| `cached-value.ts` | `defineCachedValue(name, …)`: values requests read synchronously from memory (the white-label branding, the providers Better Auth is built with), loaded at start-up and read again by the code that changes them, and by the other replicas when they hear of the change. |
| `events.ts` | The invalidation bus: `publish(channel, payload?)`, `subscribe(channel, handler)`, `startEventBus()`, `countReplicas()`. LISTEN/NOTIFY on PostgreSQL, in-process on SQLite (see "Events and shared state"). |
| `leader.ts` | The job leader among PostgreSQL replicas: a session advisory lock on a connection of its own, `isLeader()`, `onLeadershipChange()`, `getLeaderStatus()`; membership is `src/lib/cluster-nodes.ts` (`ee/docs/high-availability.md`). |
| `copy/` | The SQLite to PostgreSQL copy (`bun run db:copy-to-postgres`, `documentation/postgresql.md`). It never imports the application's database modules, so it cannot open or migrate the source through `DATABASE_URL`. |
| `break-glass.ts` | The break-glass tool (`db-tools/break-glass.js` in the image, `scripts/db/break-glass.ts`): removes the MFA policy or turns enforced SSO off from the host, on either dialect, without the application's database modules (`documentation/mfa.md`, `ee/docs/sso-enforcement.md`). |
| `sqlite-location.ts` | The SQLite file a location names, for the command-line tools (the copy, the break-glass tool). |

## Writing queries

- Import `appDb` (named; it is also the default export) and type
  parameters with `DbExecutor` (the database or a transaction), or
  `DbReader` / `DbWriter` when a helper only needs those methods.
- **Always await a query builder.** Never call `.get()`, `.all()`, `.run()`,
  `.values()` or `.execute()`: PostgreSQL has no `.get()`, and an un-awaited
  builder never runs.
- One row: `const row = await first(db.select().from(t).where(…))`, from
  `ops.ts`. Add `.limit(1)` when the filter can match several rows.
- Every function that touches the database is `async` and every call to it is
  awaited, security checks above all (`if (await isBlocked(…))`, never
  `if (isBlocked(…))`).
- Text search uses `containsText`/`likeText`: what the user typed is matched
  literally (`%` and `_` are ordinary characters, not wildcards).
- Raw SQL only through `ops.ts` (`execRaw`, or a helper). No `db.run/all/get`
  with `sql` templates: on the asynchronous facade they return arrays, not
  objects. No SQLite-only functions or keywords in `sql` templates
  (`ifnull`: use `coalesce`; `json_each`, `json_extract`: use the JSON
  helpers; `LIKE … ESCAPE`: use `containsText`/`likeText`).
- Booleans: compare with `eq(column, true)`, never with `1`.
- Dates are ISO 8601 text (`nowIso()`), as everywhere in the schema.
- Ordering: `asc`/`desc` from `ops.ts` keep SQLite's NULL placement on both
  dialects; add the primary key as the last sort key so the order is total.
  `GROUP BY` lists every selected column that is not aggregated.
- Driver errors: `isUniqueViolation(error)`, `isConstraintViolation(error)`,
  `isReadOnlyError(error)`; never driver codes or messages.
- After inserting rows with explicit ids (imports, sync), call
  `resyncIdentity(table)`. Like SQLite's AUTOINCREMENT it never moves an
  identity back, so ids are not handed out twice.
- Ids from requests (path, query, body) go through `parseRowId` or
  `routeRowId` (`src/lib/row-ids.ts`): PostgreSQL refuses an integer
  parameter that is not one (NaN, 1.5, 2^31) with an error where SQLite
  finds no row.

## Transactions

```ts
await appDb.transaction(async (tx) => {
  const user = await first(tx.select().from(users).where(eq(users.id, id)));
  if (!user) throw new NotFoundError();
  await tx.update(users).set({ name }).where(eq(users.id, id));
  await recordChange(user); // uses appDb: joins this transaction
});
```

- Every read-then-write (check, then act) runs in one transaction.
- Only database work inside a transaction: no HTTP calls, no Caddy apply, no
  file or crypto work that can wait. On SQLite a transaction holds the gate:
  every other query in the process waits for it. In development a watchdog
  logs transactions that hold it for more than 250 ms.
- Await everything inside the callback. A query that runs after its
  transaction finished (an un-awaited promise) throws
  `TransactionEscapeError` in development and tests (Drizzle reports it as
  the `cause` of its "Failed query" error); in production it runs on its
  own, outside the transaction. Deliberate background work started from
  inside a transaction goes through `outsideTransaction(fn)`.
- The default `appDb` inside a transaction's async context runs in that
  transaction, so helpers do not need a `tx` parameter to join it. A nested
  `transaction()` is a savepoint: it rolls back alone when its callback
  throws; savepoints opened side by side run one after the other.
- `tx.rollback()` rolls back and throws `TransactionRollbackError`, which
  `transaction()` rethrows.
- A statement that may fail and whose error the transaction handles (a
  unique violation it recovers from) runs in a nested transaction:
  `await tx.transaction(async (sp) => …)`. On PostgreSQL a failed statement
  aborts the whole transaction, and a writing transaction whose callback
  caught such an error and returned ends in `TransactionAbortedError`
  instead of committing. A helper that catches its own failures and may be
  called inside a transaction (bookkeeping such as the audit log) wraps the
  work in `recoverable(fn)` from `ops.ts`: a savepoint inside a
  transaction, nothing extra outside one.
- Options: `{ readOnly: true }` for a consistent snapshot that must not write
  (on SQLite, writes fail with a read-only error); `{ behavior: "immediate" }`
  to take SQLite's write lock at `BEGIN`. Nested transactions inherit the
  outer one's mode.

### How it works on SQLite

There is one connection. A process-wide first-in, first-out gate makes a
transaction exclusive: while one is open, queries and transactions from
outside its async context wait, in arrival order; a query outside any
transaction runs at once when the gate is free. Better Auth goes through the
same gate (`auth-database.ts`): its transactions are application
transactions, so application code its hooks run joins them, and its queries
made inside an application transaction join that. `VACUUM` waits for the
gate (`purgeDeletedDatabaseContent`). The synchronous Drizzle instance in
`sqlite.ts` shares the connection but not the gate: only the migrations and
repairs that run when the database is opened, before anything else, use it.

A query builder from `appDb` is bound to the transaction of the
context it is created in, not the one it runs in: Bun does not carry the
async context into a builder that an async function returns without
awaiting it. So create builders where they are awaited (the usual
`await db.select()…`); a builder made outside a transaction and awaited
inside one waits for the gate, which the transaction holds.

### How it works on PostgreSQL

`pg-executor.ts`: each transaction runs on one pooled connection. A writing
transaction is `BEGIN` (READ COMMITTED) followed by
`pg_advisory_xact_lock(<write key>)`, so writing transactions are serialised
across every process and replica, as SQLite serialises them; an in-process
FIFO queue in front lets one writer per process wait for the lock. The
`behavior` modes all take the lock at `BEGIN`. `readOnly` is
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`: no lock, a snapshot, and
writes fail. Queries outside a transaction run at once on any pooled
connection; unlike SQLite they do not wait for open transactions, and they
do not see uncommitted rows. Savepoints, the ambient context and escaped
queries behave as on SQLite.

Every connection starts with `statement_timeout` (60 s), `lock_timeout`
(30 s), `idle_in_transaction_session_timeout` (60 s), `TimeZone=UTC`,
`DateStyle=ISO` and `application_name=ingressi` (`postgres.ts`). Rows come
back as on SQLite: `bigint` and `numeric` values (counts, sums, the 64-bit
columns) as numbers, booleans as booleans, timestamps as ISO 8601 text.

Better Auth runs its own queries through Kysely (`auth-database.ts`): a
Kysely driver over the same executor, so its queries join the calling
context's transaction, its transactions take the write lock like the
application's, and the hooks it runs (through `appDb`) join them. Better
Auth's PostgreSQL type writes booleans as booleans and dates as Date
objects; `kysely-iso-dates.ts` sends those as the same ISO 8601 text
`nowIso()` writes and reads the date fields of Better Auth's schema back as
Dates (D5), so the stored rows are the same on both dialects.

Start-up (`pg-startup.ts`, from `runDatabaseStartup()`) refuses a server
older than PostgreSQL 16, a database without UTF8 and the C collation and
character classification, and a database a newer version migrated; it
applies `drizzle-pg/` and the one-time data migrations under an advisory
lock, so replicas starting together migrate once. `HA_ENABLED` (the
Litestream cluster) is refused with PostgreSQL.

## Cached values

A value read on every request that must not wait for the database, and
changes rarely, is a cached value (`cached-value.ts`):

```ts
const providers = defineCachedValue("sign-in providers", { load: readProviders, fallback: EMPTY });
providers.current();      // synchronous, from memory, never throws
await providers.changed(); // after changing what it is loaded from
```

- `register()` (src/instrumentation.ts) loads every cached value after
  `runDatabaseStartup()`, through `loadStartupCaches()`
  (src/lib/startup-caches.ts): import the defining module there.
- The code that changes the rows awaits `changed()`. Inside a transaction it
  reads the transaction's own writes, and reads again once the transaction
  has ended (`afterTransactionEnds` in `executor-core.ts`, after its COMMIT or
  ROLLBACK), so a rollback does not leave an uncommitted value behind and, on
  PostgreSQL, a read from outside the open transaction cannot put the old
  value back.
- `current()` returns the fallback before the first load, and refreshes a value
  older than its TTL (30 seconds by default) in the background, for changes
  this process did not make (a standby's replicated copy, an edit by hand).
- `changed()` also announces the change on the invalidation bus (channel
  `cached-value`, the payload is the name); every other replica reads the
  value again, and all of them read every loaded value again after a resync
  (below).

## Events and shared state

Several web replicas can share one PostgreSQL database. Whatever a process
keeps in memory goes stale when another replica changes what it came from,
and a counter kept in one process is not the cluster's. Two tools cover
this; on SQLite (one process) both keep today's behaviour and cost nothing.

### The invalidation bus (`events.ts`)

```ts
subscribe("monetization", async (event) => {
  if (event.kind === "message" && event.self) return; // this process did it
  await reloadIndex(); // a message or a resync: read the database again
});
await publish("monetization", "index"); // after the change
```

- A message says "read it again", never what the new value is: the handler
  reads the database. The payload only names what changed (an id, a name),
  at most 1000 characters. Handlers must be idempotent: a message can be
  delivered when nothing changed.
- Every process gets every message, the publishing one included
  (`event.self`). Code that already reloaded locally skips its own.
- PostgreSQL: one connection per process, outside the pool, LISTENs on
  `ingressi_events` (application_name `ingressi-events`), opened by
  `startEventBus()` from `loadStartupCaches()` (`src/lib/startup-caches.ts`)
  on every node and closed on SIGTERM and SIGINT (see "Stopping"). `publish()` runs `pg_notify()`: inside
  a writing transaction it belongs to the transaction (delivered on commit,
  dropped on a rollback, also of the savepoint it was sent in); outside one,
  or in a read-only one, it goes out at once on a pooled connection.
- The listening connection is checked every 15 seconds. When it fails, ends
  or stops answering (a server restart, a network cut), it is opened again
  with a growing delay up to 30 seconds, and every handler gets
  `{ kind: "resync" }`: messages sent meanwhile are lost, so read everything
  again. The first connection resyncs too. Until it is back, caches fall back
  on their time-to-live.
- SQLite: `publish()` calls this process's handlers, after the caller has
  left its transaction.
- `publish()` never fails the caller over a delivery problem (it logs and
  resolves to false); it throws only for an invalid channel or payload.
- LISTEN needs a session: a pooler in transaction mode (PgBouncer's default)
  between the replicas and PostgreSQL breaks the bus.
- `countReplicas()`: the web processes using the database, this one
  included: 1 on SQLite; on PostgreSQL the live replicas of `cluster_nodes`
  (`countLiveReplicas` in `src/lib/cluster-nodes.ts`, with membership's
  definition of live: a heartbeat within 45 seconds, not stopped), plus this
  process while it is not one of them.

What uses it: cached values (branding, sign-in providers: a provider change
rebuilds Better Auth on every replica), the API monetization index
(`ee/monetization/engine.ts`, channel `monetization`) and the high
availability shared state switch (`shared-state`).

### State several replicas share (tables of 0054)

| State | SQLite (one process) | PostgreSQL |
| --- | --- | --- |
| Rate limiters (`src/lib/rate-limit.ts`: credentials, portal and directory sign-in, passkey password, instance sync, pull replicas, AI questions) | memory | `rate_limit_counters` |
| Better Auth's request rate limits | memory | `auth_rate_limits` (its `database` storage) |
| A sign-in's first step until its second factor, used TOTP codes, pull replica challenges, sync-seal nonces (`src/lib/shared-runtime-state.ts`, `src/lib/sync-nonces.ts`) | bounded memory | `shared_runtime_entries` |

- A limiter's database store keeps the memory store's rules with
  single-statement upserts (no transaction, so no write lock): the key's row
  serialises concurrent attempts on every replica. A place held for an
  attempt in progress is given back by itself after a minute (a replica that
  stopped mid-attempt).
- Entries expire; `take()` reads and removes in one statement, so one
  replica gets a value. Writes run in a savepoint inside a transaction.
- Expired rows are pruned every ten minutes by the background job "shared
  runtime state pruning" (src/instrumentation.ts); reads ignore them anyway.
- Give a new limiter its own `name`, and a new kind of entry its own scope.
  Never keep a secret in an entry unencrypted (`encryptSecret`).

Deliberately per process: the AI questions a user is waiting for (one at a
time per replica; the question limits themselves are shared), state that
lives for one request, and caches of things outside the database (GeoIP
files, Caddy TLS probes, ClickHouse) or derived from secrets.

## Locks

Cluster locks (`locks.ts`) replace in-process locks and `running` flags for
work that must not overlap anywhere in the deployment:

- `withClusterLock(name, fn)` waits for the lock, first in, first out.
- `tryWithClusterLock(name, fn)` never waits: it runs `fn` when nobody holds
  or waits for the lock and otherwise returns `{ acquired: false }` (a
  periodic job skips that round, a manual action answers 409).
- `withCoalescedClusterLock(name, fn)` is for work that brings something up
  to date with the database (pushing the configuration to Caddy or to the
  slaves): a call that finds an earlier call of the process still waiting
  for the lock shares that call's run, which starts after both.

Take them outside transactions (they refuse inside one in development and
tests); they are re-entrant within the async context that holds the lock.
On PostgreSQL the holder also takes `pg_advisory_lock(hashtext(name))` on a
connection of its own, from a pool of its own (at most `LOCK_POOL_MAX`), so
the lock holds between replicas and held locks never take the connections
queries need; the wait has no time limit. The server releases the lock
when that connection is lost (the lock's session sets TCP keepalives, so a
client that stopped answering is noticed within about half a minute), and
the work is told through `signal` in its argument: another replica may hold
the lock from then on, so work that pushes state checks it and starts again
under the lock (see `applyCaddyConfig`). On SQLite the signal never aborts.

| Lock | Held by |
| --- | --- |
| `settings-update` | settings changes, configuration import and restore (`settings-update-lock.ts`) |
| `caddy-apply` | `applyCaddyConfig`: build, push, record (coalesced) |
| `instance-sync` | `syncInstances` (coalesced), a fleet re-sync with the master's configuration; the periodic sync tries it |
| `l4-ports` | `applyL4Ports` |
| `change-request-apply` | applying approved changes (`ee/approvals`) |
| `backup-destination:<id>` | a backup to one destination (tried: one run at a time) |
| `fleet-rollouts` | a pass of the rollout engine (tried) |
| `fleet-push:<instance id>` | a fleet push to one instance (tried) |

Lock order, outermost first: `change-request-apply`, `settings-update`, then
`caddy-apply`, `instance-sync` or `l4-ports`, then the tried `fleet-push:<id>`;
never the other way round.

## Stopping

Work that must end when the server stops (close a connection, write what
is counted, clear a timer) registers with `onShutdown(name, fn)` from
`src/lib/shutdown.ts`, never with `process.on`/`process.once` on `SIGTERM`
or `SIGINT`. On SIGTERM and SIGINT the handler there runs every task and
waits for them (at most 8 seconds) before the process exits; the image sets
`NEXT_MANUAL_SIG_HANDLE=true` so that Next.js leaves the signals to it (set
it too when running the server outside the image). A task registered again
under the same name replaces the earlier one: a PostgreSQL replica starts
its jobs again every time it becomes the leader, and they must not add a
listener each time (`tests/unit/ha-background-jobs.test.ts` checks both).

## Schema and migrations

- Every new integer column is classified as 32-bit or 64-bit (money in
  micros, byte sizes, counters that can grow past 2^31: 64-bit).
- Every migration exists for both dialects with the same tag.
- SQLite does not enforce foreign keys here: delete dependent rows
  explicitly.

## Tests

`createTestDb()` (`tests/helpers/db.ts`) returns the asynchronous facade
over a fresh in-memory database, with its own gate (`createTestDb({ sync:
true })` the synchronous Drizzle instance, for the few tests that need raw
access). Production code runs against it through
`vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db))`.

On PostgreSQL: `bun run test:pg` (the `postgres` Vitest project,
`TEST_DB_DIALECT=postgres`, `TEST_DATABASE_URL` naming a disposable server
whose user may create databases). It runs every test file that imports the
database layer (`src/lib/db.ts` or `src/lib/db/**`), directly or through
what it imports, found by `tests/helpers/database-test-files.ts` when the
configuration loads: a new database test runs on PostgreSQL without being
listed anywhere. The files that never reach the database layer run on SQLite
only, since nothing in them can depend on the dialect.
`tests/sqlite-only.json` lists the database tests that stay on SQLite, each
with the reason (tests of SQLite itself, of the memory stores SQLite uses);
add a file there only with a reason. Each worker has its own database, a
copy of a template migrated once per run, and `createTestDb()` empties it
(every table, identities restarted at 1) and returns its facade. A second
call within the same test gets a second database (a master and a replica);
calls in different tests reuse the first one, emptied again.
`createPgReplica()` (`tests/helpers/pg-test-db.ts`) is a second process on
the same database: a pool and an executor of its own.

`bun run test:all` (`scripts/test-all.sh`) runs the typecheck, lint,
`db:check-pg-schema`, then the tests on SQLite and on PostgreSQL; without
`TEST_DATABASE_URL` the PostgreSQL step fails rather than being skipped.

Tests that boot the real `src/lib/db` module rather than a test database
(Better Auth's HTTP handler end to end, say) call `openAppDatabase()`
(`tests/helpers/app-database.ts`) before importing it: a SQLite file in a
temporary directory, or in the `postgres` project the worker's database,
emptied, through the application's own pool.

## Benchmark

`bun run bench:db` (`scripts/bench/db-hot-paths.ts`) seeds a realistic
installation (300 proxy hosts, 50 users, groups, access lists, forward auth,
WAF, L4 hosts, API monetization) in a temporary SQLite file and times the hot
paths under Bun: the Caddy configuration build, the forward-auth verify
route, the monetization gate, the proxy host list reads, a host update and a
write transaction. `--count` lists the statements each path runs, `--profile`
splits each path's time into SQLite and everything else, `--memory` uses an
in-memory database, `--quick` is a smoke run. Run it on the staging VM, not
on a workstation. Only `scripts/bench/db-adapter.ts` uses the database API
directly, so the harness also runs on an older commit with that file swapped.

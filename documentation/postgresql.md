# PostgreSQL

Ingressi keeps its configuration in a database: hosts, certificates, users, sessions, settings and the audit log. By default that is SQLite, one file (`ingressi.db`) in the data volume. It can use PostgreSQL instead. Traffic analytics stay in ClickHouse either way, and nothing in the dashboard changes with the database.

## When to use PostgreSQL

- You already run PostgreSQL, back it up and monitor it, and want Ingressi's data there too.
- You want the database on another server, or on a managed service with point-in-time recovery.
- You want several dashboard replicas on one database (see [Several replicas](#several-replicas)).

For a single install, SQLite needs nothing and stays the default.

## Requirements

- PostgreSQL 16 or later. Ingressi is tested on PostgreSQL 17.
- A database in UTF-8 with the C collation and character classification, so text sorts and matches as it does on SQLite. Create it from `template0`:

  ```sql
  CREATE USER ingressi WITH PASSWORD 'choose-a-password';
  CREATE DATABASE ingressi OWNER ingressi TEMPLATE template0 ENCODING 'UTF8'
    LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C';
  ```

- A user that owns the database. Ingressi creates and migrates its tables itself when it starts.
- A direct connection, or a connection pooler in **session** mode. Ingressi holds sessions open for locks, for the election of the replica that runs the background jobs and for change notifications (`LISTEN`); a pooler in transaction mode (PgBouncer's default, `pool_mode = transaction`) breaks them.

Ingressi refuses to start on an older server, on a database with another collation (the message gives the `CREATE DATABASE` to use), and on a database that a newer version of Ingressi migrated.

The web container reads these environment variables:

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | `postgres://user:password@host:5432/database`. Percent-encode special characters in the password. `sslmode` works as in libpq: `disable`, `require`, `verify-ca` or `verify-full`; `sslrootcert`, `sslcert` and `sslkey` name files inside the container. `allow` and `prefer` are refused, because they may fall back to an unencrypted connection. |
| `DATABASE_SSL_CA_FILE` | The CA certificates (PEM) the server's certificate must chain to. Without an `sslmode` it means `verify-full`. |
| `DATABASE_POOL_MAX` | Connections per web container for queries: 10 by default, from 2 to 1000. Each web container also opens up to 22 more: up to 20 for cluster locks, one for the leader election and one for change notifications. |
| `DATABASE_DIALECT` | Optional, `postgres` or `sqlite`. It must agree with `DATABASE_URL`. |

The dashboard cluster on SQLite (`HA_ENABLED`, with Litestream) does not work with PostgreSQL: Ingressi refuses to start with both.

When it is stopped, Ingressi finishes its work first: it writes the API monetization usage it counted, hands the background jobs to another replica and records that it stopped. The Docker image sets `NEXT_MANUAL_SIG_HANDLE=true` for this. If you run the server outside the image (`next start` from a checkout), set it too, or Next.js exits before that work is done.

## A fresh install

### With the bundled PostgreSQL

`docker-compose.postgres.yml`, an override of `docker-compose.yml`, runs PostgreSQL 17 next to Ingressi: a database created with the C collation, a health check, the `postgres-data` volume, and no published port (only the containers of the stack reach it). The web service connects to it and starts once it is ready.

1. In `.env`, set `POSTGRES_PASSWORD` besides the usual variables. Use letters and digits only: it goes into the connection URL as it is.

   ```sh
   echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env
   ```

2. Start Ingressi with both files:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
   ```

   To leave out the `-f` options from now on, add `COMPOSE_FILE=docker-compose.yml:docker-compose.postgres.yml` to `.env`.

The first start creates the tables, then the administrator from `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Keep the web service's data volume: it holds the files the L4 port manager reads and this container's node id.

### With your own PostgreSQL

1. Create the database and its user as above.
2. In `docker-compose.yml`, set the web service's `DATABASE_URL` to the PostgreSQL URL instead of `file:/app/data/ingressi.db`. Keep the data volume mounted: it holds the files the L4 port manager reads and this container's node id.
3. Start Ingressi with `docker compose up -d`. The first start creates the tables, then the administrator from `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

## Moving an existing install

The copy tool moves an install from SQLite to PostgreSQL. It is the only supported way, and it works in that direction only. It reads the SQLite file without changing it, so the file is also your way back.

1. **Update first.** Run the version you will move with on SQLite and start it once, so it migrates the SQLite database. The copy only accepts a database at its own schema version.
2. **Stop the web container** and keep it stopped until step 7. Caddy keeps serving your sites meanwhile, except those that ask the dashboard on every request: sites behind Ingressi forward auth and monetized APIs fail until it is back, so plan a short maintenance window.

   ```sh
   docker compose stop web
   ```

3. **Back up the SQLite file.** Keep this copy until you are sure you will stay on PostgreSQL.

   ```sh
   docker compose cp web:/app/data/ingressi.db ./ingressi-sqlite-backup.db
   ```

   Installs from before the rename to Ingressi may still use `caddy-proxy-manager.db`: use the file your `DATABASE_URL` names, here and below.

4. **Create the PostgreSQL database** as in [Requirements](#requirements). It must be empty.
5. **Run the copy.** It runs in a one-off web container, with the web service's environment and volumes: the same `SESSION_SECRET` (stored secrets stay encrypted with it) and the same certificate files for the connection. Pass the PostgreSQL URL as `DATABASE_URL`:

   ```sh
   export POSTGRES_URL='postgres://ingressi:choose-a-password@db.example.com:5432/ingressi?sslmode=verify-full'
   docker compose run --rm --entrypoint bun -e DATABASE_URL="$POSTGRES_URL" \
     web db-tools/copy-sqlite-to-postgres.js --from /app/data/ingressi.db
   ```

   The copy migrates the PostgreSQL database as a start would, copies every table in one transaction, then compares both databases table by table: row counts and a checksum of the content. It prints the result per table. If anything differs or fails, it rolls everything back, prints why and exits with status 1; the PostgreSQL database then holds no data. In our tests, 150,000 rows (100,000 of them audit events) copy and verify in about six seconds.

6. **Switch.** In `docker-compose.yml`, set the web service's `DATABASE_URL` to the PostgreSQL URL.
7. **Start** the web container:

   ```sh
   docker compose up -d web
   ```

   On its first start on PostgreSQL, Ingressi also removes rows that older releases left behind when they deleted the row those belonged to, such as the members of a deleted group. The same clean-up runs on every start on SQLite; the copy carries such rows over as they are.

8. **Check.** Sign in (sessions are copied, so you may still be signed in), then look at the proxy hosts, users, certificates and the audit log. `docker compose logs web` shows no database errors, and **Needs attention** on the overview does not report a failed Caddy apply.

### Moving to the bundled PostgreSQL

To move to the database of `docker-compose.postgres.yml`, follow the steps above with these changes:

- Step 4: set `POSTGRES_PASSWORD` in `.env` as in [A fresh install](#with-the-bundled-postgresql), then start the database alone: `docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d postgres`. It starts empty.
- Step 5: run the copy through the override, which already points `DATABASE_URL` at that database:

  ```sh
  docker compose -f docker-compose.yml -f docker-compose.postgres.yml run --rm --entrypoint bun \
    web db-tools/copy-sqlite-to-postgres.js --from /app/data/ingressi.db
  ```

- Steps 6 and 7: start everything with the override, `docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d`.

### Going back

There is no copy from PostgreSQL back to SQLite. To go back, stop the web container, set `DATABASE_URL` back to the SQLite file (`file:/app/data/ingressi.db`), and start it. If the file was changed or removed since, restore the backup from step 3 into the data volume first. Changes made while running on PostgreSQL are not carried back. With the bundled PostgreSQL, start without `docker-compose.postgres.yml` (and without `COMPOSE_FILE`): the web service is then on the SQLite file again.

### What the copy refuses

Every refusal says what to do, and nothing is copied:

- **A SQLite database in use.** A write-ahead log or an unfinished rollback journal next to the file means another process has it open, or did not close it cleanly. Stop the web container; if it is already stopped, start and stop it once. The copy cannot see a web container that merely has the file open, so always stop it first.
- **A different schema version.** A SQLite database behind this version: start this version on it once (step 1). Ahead of it: run the copy with the version that migrated it, or a newer one.
- **Secrets the configured secret does not decrypt.** Run the copy with the web container's `SESSION_SECRET`, and `SESSION_SECRET_PREVIOUS` if it is set. `docker compose run web` uses them already.
- **A PostgreSQL server or database Ingressi cannot use**: older than 16, another collation, or migrated by a newer version.
- **A PostgreSQL database that holds Ingressi data, or that a web container is connected to.** Use an empty database. `--replace` deletes the Ingressi data already in it before copying; the copy prints how many rows per table it deletes.
- **A value PostgreSQL cannot store**, such as an integer out of range or text with a NUL character. The message names the table, column and row. Correct or delete that row with Ingressi stopped, then run the copy again.

### Options

| Option | What it does |
| --- | --- |
| `--from <file>` | The SQLite database. Default: the file `DATABASE_URL` names when it is a SQLite location, otherwise `./data/ingressi.db`. |
| `--to <url>` | The PostgreSQL database. Default: `DATABASE_URL` when it is a `postgres://` URL. Prefer the environment variable: a URL on the command line ends up in your shell history. |
| `--replace` | Delete the Ingressi data already in the PostgreSQL database before copying, instead of refusing. |
| `--verify-only` | Compare the two databases and change nothing. Run it before you start the web container on PostgreSQL: from then on the two differ. |
| `--batch-size <n>` | Rows per statement, 2000 by default. |

The exit status is 0 when the copy (or the comparison) succeeded, 1 when it was refused, failed or found differences, and 2 for a wrong option. From a source checkout the same tool runs as `bun run db:copy-to-postgres`.

## Upgrades

Upgrade as usual: pull the new image and recreate the web container. Its first start migrates the PostgreSQL database. An older version refuses to start on a database a newer one migrated, so with several replicas, stop every one of them before you start the new version ([Upgrades and restarts](../ee/docs/high-availability.md#upgrades-and-restarts)).

## Several replicas

Several web containers on one PostgreSQL database, for failover and load sharing: see [High availability](../ee/docs/high-availability.md#postgresql-replicas). `docker-compose.postgres.yml` starts a second one with the `replicas` profile. Each one needs its own data volume, or its own `INGRESSI_NODE_ID`: two containers with one node id do not run side by side.

## Backups and deleted secrets

Back up PostgreSQL with your usual tools, such as `pg_dump` or point-in-time recovery, and keep `SESSION_SECRET` with the backups: the secrets Ingressi stores are encrypted with it. With the bundled PostgreSQL:

```sh
docker compose -f docker-compose.yml -f docker-compose.postgres.yml exec -T postgres \
  pg_dump -U ingressi -d ingressi --format=custom > ingressi-$(date +%F).dump
```

Restore with the web container stopped, into an empty database (`pg_restore -U ingressi -d ingressi --no-owner`). Back up the web service's data volume as well.

On SQLite, Ingressi overwrites deleted content in the database file. PostgreSQL keeps deleted and replaced rows in its files until `VACUUM` reuses the space, and in its write-ahead log and backups for as long as you keep them. A secret you replace in the dashboard may stay readable there, encrypted: if one leaks, revoke it at its source as well.

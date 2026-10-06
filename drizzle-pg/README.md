# PostgreSQL migrations

This folder builds the PostgreSQL database. `drizzle/` builds the SQLite one. Both describe the same schema, `src/lib/db/schema.sqlite.ts`, and must stay in step.

## What is here

- `0000_baseline.sql`: the whole schema as the SQLite migrations leave it at `0052_ha_shared_state`. The tables and indexes are drizzle-kit's output for `src/lib/db/schema.pg.ts`, unchanged. The end of the file adds what the Drizzle schema does not express, as the SQLite migrations do:
  - the `forward_auth_access` CHECK of `drizzle/0017` (a user or a group, never both or neither);
  - the `users` organisation-role triggers of `drizzle/0041`, which raise `organization role mismatch` (SQLSTATE 23514, `check_violation`; dropped again by `0059_drop_multi_tenancy`);
  - the `users.disabledAt` triggers of `drizzle/0047`, as BEFORE triggers.
- `meta/_journal.json`: the migrations in order. Drizzle's migrator applies a migration when its `when` is later than that of the newest migration already applied.
- `meta/NNNN_snapshot.json`: drizzle-kit's record of the schema after each migration. `drizzle-kit generate` compares the schema with the newest one.
- `meta/_sqlite-equivalence.json`: which SQLite migration the baseline equals. Its name starts with an underscore so drizzle-kit does not read it as a snapshot.

The baseline's journal entry has the `idx` and `when` of `0052_ha_shared_state`. So a database at the baseline counts as being at SQLite 0052, and drizzle-kit numbers the next PostgreSQL migration 0053, like the next SQLite one.

## Rules

- From 0053 on, every migration is a pair: `drizzle/NNNN_name.sql` and `drizzle-pg/NNNN_name.sql`, with the same tag, `idx` and `when` in both journals. `tests/unit/db-migration-pairs.test.ts` checks this.
- Never edit a migration that has shipped, the baseline included. Add a new pair.
- No foreign keys. SQLite does not enforce the ones it declares, so PostgreSQL has none either; code deletes dependent rows itself.
- Identifiers are quoted, with Drizzle's camelCase column names (`"customRoleId"`).
- Timestamps are ISO 8601 text, as the application writes them. Booleans are `boolean`. Integer widths follow `src/lib/db/pg-column-types.ts`.
- Nothing newer than PostgreSQL 16, the oldest version supported. `tests/unit/db-pg-migrations.test.ts` refuses known newer syntax and functions.
- The database must use UTF8 with `LC_COLLATE` and `LC_CTYPE` `C` (`CREATE DATABASE … TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`), so text compares and sorts byte by byte, as on SQLite.

## Adding a migration pair

1. Change the tables in `src/lib/db/schema.sqlite.ts`. Classify every new integer column as `int4` or `int8` in `src/lib/db/pg-column-types.ts`. Then regenerate `src/lib/db/schema.ts` and `src/lib/db/schema.pg.ts`:

   ```sh
   bun run db:generate-pg-schema
   bun run db:check-pg-schema   # fails while either file is stale
   ```

2. Write the SQLite migration by hand, `drizzle/NNNN_name.sql`, and append its entry to `drizzle/meta/_journal.json` (`idx` NNNN, a `when` later than the last one, `breakpoints: true`).

3. Generate the PostgreSQL migration from the schema change:

   ```sh
   bunx drizzle-kit generate --config drizzle.pg.config.ts --name name
   ```

   This writes `drizzle-pg/NNNN_name.sql`, `drizzle-pg/meta/NNNN_snapshot.json` and a journal entry. It needs no database. Set the entry's `when` to the SQLite entry's. If the numbers differ (SQLite skipped one), rename the SQL file and the snapshot, and fix the entry's `idx` and `tag`.

4. Read the generated SQL. drizzle-kit asks whether a changed column or table was renamed; answer it, or write that part by hand. Data changes, triggers and CHECK constraints are never generated: add them by hand, in both migrations. For a migration with no schema change, add `--custom`: drizzle-kit writes a file to fill in by hand and keeps the snapshot chain intact.

5. Run the tests:
   - `tests/unit/db-migration-pairs.test.ts` and `tests/unit/db-pg-migrations.test.ts`: the pair, the snapshots, no foreign keys, PostgreSQL 16;
   - `tests/integration/sqlite-migrations-match-schema.test.ts`: SQLite builds the schema;
   - `tests/integration/pg/`: PostgreSQL builds the schema and behaves like SQLite. They run when `TEST_DATABASE_URL` points to a disposable server whose user may create databases; each file creates its own database and drops it.

## Regenerating the baseline

The baseline is fixed once PostgreSQL support ships. Before that, it can be regenerated after a schema change instead of adding a pair:

1. Run `bun run db:generate-pg-schema`.
2. Keep the end of `0000_baseline.sql` (the part after the indexes), then delete `0000_baseline.sql` and `meta/0000_snapshot.json`, and empty `entries` in `meta/_journal.json`.
3. Run `bunx drizzle-kit generate --config drizzle.pg.config.ts --name baseline`.
4. Put back the header comment and the hand-written end. Set the journal entry's `idx` and `when` to those of the SQLite migration the baseline now equals, and name it in `meta/_sqlite-equivalence.json`.

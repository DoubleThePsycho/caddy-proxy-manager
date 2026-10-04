# db-async codemod

Moves code from the synchronous Drizzle API (`db.select()….get()`, sync
`db.transaction`) to the asynchronous, dialect-neutral database layer
described in `src/lib/db/README.md`. It uses the TypeScript type checker, so
it recognises database calls by what they resolve to, not by variable names,
and it can be run again on a newer base: code that is already converted is
left alone.

**Why it is kept.** This branch converted the whole code base, but code
keeps arriving from the upstream branch, which is still written against the
synchronous SQLite API. Each time this branch is rebased onto upstream (or
upstream is merged), run the codemod on the result (see
[Re-running on a newer base](#re-running-on-a-newer-base)): it converts the
new code and what calls it, and lists what it cannot convert. Do not delete
it while upstream still uses the synchronous API.

| File | What it is |
| --- | --- |
| `project.ts` | Loads the program from `tsconfig.json`; scopes, review areas (R1–R7, `areaOf`), excluded paths. |
| `closure.ts` | The analysis: the DB closure and the risky contexts. |
| `rewrite.ts` | Turns the closure into text edits, file by file. |
| `report.ts` | JSON and console summaries. |
| `analyze.ts` | Writes `db-async-closure.json`. |
| `transform.ts` | The codemod command. |

## Running it

```sh
# What reaches the database, and what cannot be converted mechanically.
bun run codemod:db-async:analyze                # writes docs/db-async-closure.json (git-ignored)

# The codemod (production code by default).
bun run codemod:db-async                        # --dry-run: counts and the manual list, writes nothing
bun run codemod:db-async --review               # also the sites to review (converted, but listed)
bun run codemod:db-async --out-dir /tmp/out     # write the rewritten files elsewhere, to diff them
bun run codemod:db-async --write                # rewrite in place
bun run codemod:db-async --check                # exit 1 while anything is left to convert or restructure (CI)
bun run codemod:db-async --report docs/db-async-transform.json
bun run codemod:db-async --scope tests          # tests/; --scope all for both
bun run codemod:db-async --write src/lib/models ee/scim 'ee/**/store.ts'   # only these paths
bun run codemod:db-async --write --await-unawaited   # re-run on a newer base (see below)
```

It needs the whole program in memory (about as much as `bun run typecheck`;
run it on the staging VM) and takes about a minute. Path filters only limit
which files are written: the analysis always covers the whole repository, so
the closure is complete; calls to await in files left out are counted in the
output ("calls to await are in files outside the selection").

## What it changes

- **Terminals.** `.all()` and `.run()` are dropped and the builder is
  awaited. `.get()` becomes `await first(builder.limit(1))`; a builder that
  already has `.limit()` keeps it; `.returning().get()`, which Drizzle types
  without `undefined`, becomes `(await first(…))!` so the type does not change.
  Raw `db.run/all/get(sql)` become `execRaw(sql, tx?)`.
- **Transactions.** `db.transaction((tx) => …, options)` becomes
  `await appDb.transaction(async (tx) => …, options)`; a callback return type
  `T` becomes `Promise<T>`.
- **Propagation, to a fixpoint.** A function that runs a query, or calls a
  function that became async, becomes `async` and the call is awaited
  (`(await f()).x` where precedence needs parentheses; `void f()` becomes
  `await f()`). Explicit return types become `Promise<…>`, overload signatures
  too, and `ReturnType<typeof f>` becomes `Awaited<ReturnType<typeof f>>`.
  Callbacks follow the signature that types them:
  - a signature declared in this repository (an interface member, a
    parameter's function type, a type alias) returns a Promise, every other
    implementation of it becomes async, function values passed on into it
    change with it, and its calls are awaited;
  - a generic wrapper of this repository (`safely(fn)`, `changePins(fn)`)
    awaits its callback and becomes async, so the work it does after the call
    still runs after the callback;
  - a library call whose result follows the callback (`AsyncLocalStorage.run`)
    is awaited; library callbacks whose contract accepts a Promise (Vitest
    tests, `.then`, Better Auth hooks) simply become async.
- **Imports and types.** The default `db` becomes the named `appDb` from the
  same module. `BaseSQLiteDatabase<"sync", …>` becomes `DbExecutor`,
  `Parameters<Parameters<typeof db.transaction>[0]>[0]` becomes `AppTx` and
  `typeof db` becomes `AppDb`, from `@/src/lib/db/types`; local aliases of
  them are removed (exported ones are kept, pointing at the new type), and
  imports only they used are dropped. `first`, `execRaw` and the SQL helpers
  come from `@/src/lib/db/ops` (as `dbFirst` and so on where the file already
  has a local of that name).
- **Dialect-neutral SQL** (`src/lib/db/ops.ts`). `asc`/`desc` come from ops
  (same SQL on SQLite, explicit NULL order on PostgreSQL).
  ``like(col, `%${x}%`)`` becomes `containsText(col, x)`, other `like()` calls
  `likeText()`. In `sql` templates: `ifnull(` becomes `coalesce(`, `` sql`0` ``
  becomes `sqlFalse()`, `lower(${a}) = ${b}` becomes `lowerEquals(a, b)`,
  `${a} LIKE ${b} ESCAPE '\'` becomes `likeText(a, b)`, the
  `json_valid`/`json_extract` and `json_each` shapes become `jsonTextAt` and
  `jsonArrayIncludesAny` (``sql<T>`…` `` keeps its type as ``sql<T>`${helper(…)}` ``).

It never changes `src/lib/db.ts`, `src/lib/db/**`,
`ee/high-availability/cluster/**` or `src/lib/clickhouse/**`. ClickHouse queries in `src/lib/analytics/**` are not
Drizzle SQLite builders, so the rules never select them. Calls from those
files to functions that became async are reported (`excluded-file`).

## Re-running on a newer base

Converted code is left as it is (awaited calls, async functions, `appDb`,
`Promise<…>` types, the ops helpers), so the codemod can run again after
branches written against the synchronous API are merged: it converts their
terminals and transactions and propagates from there. Such branches may also
call functions that are now async the synchronous way (`logAuditEvent(…);`,
`if (isProtectedUser(…))`). By default those are reported
(`floating-async-call`, `unawaited-async-call`); with `--await-unawaited`
they are awaited and their functions become async too. It is off by default
because on the base being converted a dropped promise may be deliberate.
Since the conversion `appDb` is also the default export of
`src/lib/db.ts`, so such a branch's `import db from "@/src/lib/db"` already
gets the asynchronous facade: its `.get()`, `.all()` and `.run()` calls and
its `db.transaction(fn)` with a callback that is not async are still found
and converted (and the merge does not typecheck until they are). Run with
`--scope all` so its tests are converted too.

## Risky contexts and the manual list

Where `await` and `async` cannot preserve the behaviour, the codemod still
awaits the call but leaves the function synchronous. The compiler then stops
at each such site (TS1308, "await is only allowed within async functions";
TS2524 in parameter defaults), so after `--write` the list of `bun run
typecheck` errors is the manual list, and nothing silently changes meaning.
A second run reports those awaits again as `pending-manual` until they are
fixed. The function around an array callback is converted (the loop or
`Promise.all` goes there); exit hooks, timers, getters and the like stay as
they are.

Manual kinds (the run prints each with `file:line`):

| Kind | What to do |
| --- | --- |
| `array-callback` | `.map/.filter/.sort/.some/.every/.find/.reduce/.forEach` callbacks: a `for…of` loop (keeps the order, one query at a time) or `Promise.all` (only for reads). |
| `accessor`, `constructor`, `class-field`, `parameter-default`, `generator`, `type-predicate` | Cannot be async: a method, a factory, a value read before the call, or a predicate that returns a value the caller narrows on. |
| `exit-handler`, `signal-handler` | An exit hook cannot wait: flush on SIGTERM/SIGINT, await it, then exit. |
| `void-callback` | Timers, events, promise executors ignore the result: make the callback async and catch inside. |
| `sync-callback`, `function-value`, `jsx-callback`, `client-component` | The consumer expects a plain value or cannot be followed: change the consumer. |
| `module-level` | Move the work into an awaited start-up step or a lazy async getter. |
| `excluded-file` | Await it by hand (for example `src/lib/db/startup.ts`). |
| `run-result`, `values-terminal`, `prepared-statement`, `raw-sql-result` | Use `.returning()` and count rows, select columns, inline values, `execRaw` rows. |
| `raw-client`, `driver-error`, `runtime-sqlite-core`, `sync-db-type`, `sqlite-sql` | Use the executor, `isUniqueViolation`/`isConstraintViolation`/`isReadOnlyError`, `referencesTo`, the `types.ts` types, an ops helper. |
| `unawaited-async-call` | An async database function used as a value (`if (f())`, `f().x`): await it. |

Review kinds (converted; `--review` lists them, for the semantic review):
`boolean-context` (awaited security predicates: add negative tests),
`check-then-act` (reads then writes outside a transaction: atomic while
synchronous, interleaves once async), `generic-wrapper`, `signature-change`,
`void-call`, `recursion`, `server-component`, `like-semantics`, `json-text`,
`floating-async-call`, `promise-combinator`.

## Reviewing a run

1. `bun run codemod:db-async --review > review.txt` on the base you will
   convert; read the manual list per area.
2. `bun run codemod:db-async --out-dir /tmp/out`, then
   `diff -ru src /tmp/out/src` (and `app`, `ee`) to read the diff before
   touching the tree, or `--write` once nobody else is changing the same files.
3. `bun run typecheck`: every error should be a listed manual site. Fix them,
   re-run the codemod (it converts what the fixes made async), repeat until
   `--check` passes.

## db-async-closure.json

- `summary`: counts per scope (production, tests): Drizzle sites by kind,
  functions that reach the database, those that become async, blocked ones,
  calls to await, the most awaited functions, files touched, risky contexts
  by kind and manual ones by area.
- `functions.production` / `functions.tests`: every function, method,
  callback and signature that reaches the database: `id` (`file:line:column`),
  `name`, `kind`, `area`, `async` (already), `converts`, `blocked` (the risky
  kind that keeps it synchronous), `inTransaction`, `reads`, `writes`, `why`
  (the terminal, transaction or call that puts it in the closure) and
  `callers` (call sites and the functions they are in).
- `risky.production` / `risky.tests`: every risky context with its kind,
  `manual`, position, area, message and the code at the site.

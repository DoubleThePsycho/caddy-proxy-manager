#!/bin/sh
# Everything a change must pass: typecheck, lint, the generated PostgreSQL
# schema, the unit and integration tests on SQLite, then on PostgreSQL.
#
#   TEST_DATABASE_URL  a disposable PostgreSQL 16+ server whose user may create
#                      and drop databases (required: the PostgreSQL suite is
#                      part of the run, never skipped). For example:
#                        docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=test \
#                          -e POSTGRES_INITDB_ARGS="--locale=C --encoding=UTF8" postgres:17-alpine
#                        TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres
#   E2E=1              also run the Playwright suite (it starts the Docker stack).

run_step() {
  label="$1"
  shift

  printf '\n==> %s\n' "$label"
  "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '    %s: PASS\n' "$label"
  else
    printf '    %s: FAIL (%s)\n' "$label" "$status"
  fi
  return "$status"
}

no_postgres() {
  echo "TEST_DATABASE_URL is not set: the PostgreSQL suite needs a disposable server (see the top of scripts/test-all.sh)." >&2
  return 1
}

result() {
  if [ "$1" -eq 0 ]; then printf PASS; else printf FAIL; fi
}

run_step "Typecheck" bun run typecheck
typecheck_status=$?

run_step "Lint" bun run lint
lint_status=$?

run_step "PostgreSQL schema" bun run db:check-pg-schema
schema_status=$?

run_step "Vitest (SQLite)" bun run test
vitest_status=$?

# Every test file that imports the database layer, on PostgreSQL
# (tests/vitest.config.ts; tests/sqlite-only.json lists the exceptions).
if [ -n "${TEST_DATABASE_URL:-}" ]; then
  run_step "Vitest (PostgreSQL)" bun run test:pg
else
  run_step "Vitest (PostgreSQL)" no_postgres
fi
vitest_pg_status=$?

e2e_status=0
if [ "${E2E:-0}" = "1" ]; then
  run_step "Playwright" bun run test:e2e
  e2e_status=$?
fi

printf '\n==> Summary\n'
printf '    Typecheck: %s\n' "$(result "$typecheck_status")"
printf '    Lint: %s\n' "$(result "$lint_status")"
printf '    PostgreSQL schema: %s\n' "$(result "$schema_status")"
printf '    Vitest (SQLite): %s\n' "$(result "$vitest_status")"
printf '    Vitest (PostgreSQL): %s\n' "$(result "$vitest_pg_status")"
if [ "${E2E:-0}" = "1" ]; then
  printf '    Playwright: %s\n' "$(result "$e2e_status")"
fi

for status in "$typecheck_status" "$lint_status" "$schema_status" "$vitest_status" "$vitest_pg_status" "$e2e_status"; do
  [ "$status" -eq 0 ] || exit 1
done

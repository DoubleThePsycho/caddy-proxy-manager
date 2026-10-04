/**
 * The whole E2E suite with the dashboard on PostgreSQL: the specs of
 * playwright.config.ts on the stack of tests/docker-compose.test.pg.yml
 * (PostgreSQL 17 with the C collation; everything else as on SQLite).
 * The global setup and teardown bring that stack up and down
 * (tests/helpers/e2e-stack.ts).
 *
 *   bunx playwright test --config tests/playwright.pg.config.ts
 */
import { defineConfig } from '@playwright/test';
import sqliteConfig from './playwright.config';

process.env.E2E_STACK = 'postgres';

export default defineConfig(sqliteConfig);

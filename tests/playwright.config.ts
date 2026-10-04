import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

// The stack this config runs on (tests/helpers/e2e-stack.ts): the dashboard
// on SQLite. tests/playwright.pg.config.ts runs the same specs on PostgreSQL.
process.env.E2E_STACK = 'sqlite';

export default defineConfig({
  testDir: './e2e',
  // Two dashboard replicas need their own stack (tests/playwright.replicas.config.ts).
  testIgnore: ['**/replicas/**'],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000, // functional tests need time for Caddy reloads
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    storageState: resolve(__dirname, '.auth/admin.json'),
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-iphone',
      use: { ...devices['iPhone 15'] },
      testMatch: '**/mobile/**/*.spec.ts',
    },
  ],
});

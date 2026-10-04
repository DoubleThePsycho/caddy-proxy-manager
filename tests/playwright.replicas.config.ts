/**
 * Two dashboard replicas on one PostgreSQL (ee/docs/high-availability.md,
 * "PostgreSQL replicas"): the specs in tests/e2e/replicas/ on the stack of
 * tests/docker-compose.test.replicas.yml, brought up by
 * tests/global-setup.replicas.ts. The specs stop and start replicas, so the
 * files run in order (their names are numbered) on one worker.
 *
 *   bunx playwright test --config tests/playwright.replicas.config.ts
 */
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

process.env.E2E_STACK = 'replicas';

export default defineConfig({
  testDir: './e2e/replicas',
  globalSetup: './global-setup.replicas.ts',
  globalTeardown: './global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
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
  ],
});

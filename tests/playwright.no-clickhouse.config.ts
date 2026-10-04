import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './e2e',
  // Two dashboard replicas need their own stack (tests/playwright.replicas.config.ts).
  testIgnore: ['**/replicas/**'],
  globalSetup: './global-setup.no-clickhouse.ts',
  globalTeardown: './global-teardown.no-clickhouse.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
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

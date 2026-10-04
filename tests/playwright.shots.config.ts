/**
 * Screenshots of the dashboard for the public website and the README:
 * `bun run screenshots:site`. tests/shots/screenshots.spec.ts says what is
 * written where (SHOTS_OUTPUT_DIR, default test-results/site-screenshots).
 *
 * Runs on the end-to-end Docker stack with the same global setup and
 * teardown as playwright.config.ts: the stack is built and started, seeded
 * with synthetic data (tests/shots/seed.ts), photographed and removed again.
 * Paid screens need a development license key in tests/.auth/license.txt
 * (git-ignored, removed by the teardown) or at SHOTS_LICENSE_FILE.
 *
 * While iterating: SHOTS_KEEP_STACK=1 leaves the stack up after the run,
 * SHOTS_REUSE_STACK=1 runs against a stack that is already up (no setup or
 * teardown), and SHOTS_SKIP_SEED=1 skips seeding an already seeded stack.
 */
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const reuse = process.env.SHOTS_REUSE_STACK === '1';
const keep = process.env.SHOTS_KEEP_STACK === '1';

export default defineConfig({
  testDir: './shots',
  globalSetup: reuse ? undefined : './global-setup.ts',
  globalTeardown: reuse || keep ? undefined : './global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: 'list',
  outputDir: '../test-results/shots-output',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:3000',
    storageState: resolve(__dirname, '.auth/admin.json'),
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'en-GB',
    timezoneId: 'Europe/Rome',
    trace: 'off',
  },
  projects: [
    { name: 'seed', testMatch: /seed\.setup\.ts$/ },
    { name: 'shots', testMatch: /screenshots\.spec\.ts$/, dependencies: ['seed'] },
  ],
});

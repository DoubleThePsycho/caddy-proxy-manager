/**
 * The dashboard screenshots of the public website and the README, taken on
 * the seeded e2e stack (seed.setup.ts) at 1440×900 in the dark theme.
 *
 * Writes to SHOTS_OUTPUT_DIR (default test-results/site-screenshots):
 *   overview.png, analytics.png, security-events.png, host-editor.png,
 *   users-and-sign-in.png, compliance.png  → the website's site/assets/screenshots/
 *   preview.png (1200×630, og:image)        → the website's site/assets/images/
 *   dashboard.png                           → this repository's .github/assets/
 *   host-editor-security.png, host-detail.png, security-event-detail.png,
 *   certificates.png, access-lists.png,
 *   audit-log.png                           → the website's feature walkthrough
 * and full-page copies under review/ for checking what each page showed.
 * Look at every image before publishing it: synthetic data only, nothing
 * half-loaded, no error banners. The License page is never captured (it
 * shows the licensee).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dashboardFonts, previewHtml } from './preview';

const OUT = resolve(process.env.SHOTS_OUTPUT_DIR || 'test-results/site-screenshots');
const REVIEW = resolve(OUT, 'review');

/** Re-encodes a PNG with a 256-colour palette when sharp (Next.js's image library) is installed and it comes out smaller. */
async function optimise(png: Buffer): Promise<Buffer> {
  try {
    const name = 'sharp';
    const mod = await import(name);
    const sharp = mod.default ?? mod;
    const out: Buffer = await sharp(png).png({ palette: true, quality: 100, effort: 10, compressionLevel: 9, dither: 0 }).toBuffer();
    return out.length < png.length ? out : png;
  } catch {
    return png;
  }
}

async function save(name: string, png: Buffer): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const optimised = await optimise(png);
  writeFileSync(resolve(OUT, name), optimised);
  console.log(`[shots] ${name}: ${Math.round(optimised.length / 1024)} KiB (raw ${Math.round(png.length / 1024)} KiB)`);
}

async function review(page: Page, name: string): Promise<void> {
  mkdirSync(REVIEW, { recursive: true });
  await page.screenshot({ path: resolve(REVIEW, `${name}-full.png`), fullPage: true, animations: 'disabled' });
}

/** Waits for fonts, charts and late data, then captures the viewport. */
async function capture(page: Page, name: string): Promise<Buffer> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await expect(page.getByText(/something went wrong|internal server error/i)).toHaveCount(0);
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await save(`${name}.png`, png);
  await review(page, name);
  return png;
}

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('theme', 'dark');
    } catch {
      // Storage blocked: next-themes falls back to the dark default.
    }
  });
  page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${page.url()}: ${message.text()}`);
  });
});

test.afterAll(() => {
  for (const error of errors) console.log(`[shots] browser error: ${error}`);
});

async function hostId(page: Page, name: string): Promise<number> {
  const response = await page.request.get('/api/v1/proxy-hosts');
  const body = await response.json();
  const list = (Array.isArray(body) ? body : body.proxyHosts ?? body.hosts ?? body.items ?? []) as { id: number; name: string }[];
  const host = list.find((h) => h.name === name);
  expect(host, `proxy host ${name}`).toBeDefined();
  return host!.id;
}

test('overview', async ({ page }) => {
  // The traffic signals behind "Needs attention" are cached for 30 seconds: wait until the API has
  // them, so a slow first query on a busy machine cannot leave them out of the page.
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await page.request.get('/api/v1/overview/attention', { timeout: 60_000 }).catch(() => null);
    const body = response?.ok() ? await response.json() : null;
    if (body?.items?.some((item: { source?: string }) => item.source === 'traffic')) break;
    await page.waitForTimeout(5000);
  }
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(page.getByText('shop.example.com').first()).toBeVisible({ timeout: 30_000 });
  const png = await capture(page, 'overview');
  await save('dashboard.png', png);
});

test('analytics', async ({ page }) => {
  await page.goto('/analytics?range=7d');
  await expect(page.getByRole('heading', { name: 'Traffic analytics', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ask about your traffic' })).toBeVisible();
  await expect(page.getByText('shop.example.com').first()).toBeVisible({ timeout: 30_000 });
  await capture(page, 'analytics');

  // For review: the Ask box with the answer to a saved question.
  const ask = page.getByRole('region', { name: 'Ask about your traffic' });
  const run = ask.getByRole('button', { name: /^Run/ }).first();
  if (await run.isVisible().catch(() => false)) {
    await run.click();
    await page.waitForTimeout(4000);
    await review(page, 'analytics-answer');
    await page.screenshot({ path: resolve(REVIEW, 'analytics-answer-viewport.png'), animations: 'disabled' });
  }
});

test('security events', async ({ page }) => {
  await page.goto('/security?range=24h');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('203.0.113.240').first()).toBeVisible({ timeout: 30_000 });
  await capture(page, 'security-events');
  await page.goto('/security?range=7d');
  await page.waitForTimeout(3000);
  await review(page, 'security-events-7d');
});

test('host editor', async ({ page }) => {
  const id = await hostId(page, 'Shop');
  await page.goto(`/proxy-hosts/${id}/edit`);
  await expect(page.getByTestId('host-editor-bar')).toBeVisible();
  await capture(page, 'host-editor');
  for (const section of ['Security', 'Access']) {
    const link = page.getByRole('navigation', { name: 'Host settings' }).getByRole('link', { name: new RegExp(`^${section}`) });
    if (await link.isVisible().catch(() => false)) {
      await link.click();
      await page.waitForTimeout(1500);
      if (section === 'Security') await capture(page, 'host-editor-security');
      else await page.screenshot({ path: resolve(REVIEW, `host-editor-${section.toLowerCase()}.png`), animations: 'disabled' });
    }
  }
  await page.goto(`/proxy-hosts/${id}`);
  await page.waitForTimeout(3000);
  await capture(page, 'host-detail');
});

test('security event detail', async ({ page }) => {
  // A WAF block of the SQL injection rule: its detail says why and offers an exclusion.
  const filters = JSON.stringify([{ dim: 'waf_rule', op: 'is', value: '942100' }]);
  await page.goto(`/security?range=24h&kind=waf&filters=${encodeURIComponent(filters)}`);
  const wafRow = page.locator('table tr').filter({ hasText: 'Blocked by WAF' }).filter({ hasText: '942100' }).first();
  await expect(wafRow).toBeVisible({ timeout: 30_000 });
  await wafRow.locator('button[aria-expanded="false"]').click();
  const open = page.locator('table button[aria-expanded="true"]').first();
  await expect(open).toBeVisible();
  await page.waitForTimeout(1500);
  await open.evaluate((button) => {
    const row = button.closest('tr');
    if (row) window.scrollBy(0, row.getBoundingClientRect().top - 140);
  });
  await capture(page, 'security-event-detail');
});

for (const [name, path] of [
  ['certificates', '/certificates'],
  ['access-lists', '/access-lists'],
  ['audit-log', '/audit-log'],
] as const) {
  test(name, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await capture(page, name);
  });
}

test('users and sign-in', async ({ page }) => {
  await page.goto('/users');
  await expect(page.getByText('giulia.romano@example.com').first()).toBeVisible({ timeout: 30_000 });
  await capture(page, 'users-and-sign-in');
});

test('compliance', async ({ page }) => {
  await page.goto('/compliance');
  await expect(page.getByRole('heading', { name: 'Compliance', level: 1 })).toBeVisible();
  await capture(page, 'compliance');
});

test('social preview', async ({ page }) => {
  const analytics = readFileSync(resolve(OUT, 'analytics.png'));
  await page.setViewportSize({ width: 1200, height: 630 });
  // Without the sidebar, from the filter bar down: the totals and the chart read better than text at thumbnail size.
  await page.setContent(previewHtml(analytics, await dashboardFonts(page.request), { top: 290, left: 262 }), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await save('preview.png', await page.screenshot({ animations: 'disabled' }));
});

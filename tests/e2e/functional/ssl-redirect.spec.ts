/**
 * Functional tests: HTTP→HTTPS redirect when ssl_forced is enabled.
 *
 * Creates a proxy host with "Redirect HTTP to HTTPS" on (the host editor's
 * default) and verifies that plain HTTP requests receive a 308 permanent
 * redirect to HTTPS.
 *
 * Domain: func-ssl.test
 */
import { test, expect } from '@playwright/test';

import { httpGet, waitForRoute } from '../../helpers/http';
import { fillHostBasics, openCreateHostDialog, openEditorSection, saveHostEditor } from '../../helpers/proxy-api';

const DOMAIN = 'func-ssl.test';

test.describe.serial('SSL Redirect (ssl_forced)', () => {
  test('setup: create proxy host with ssl_forced=true', async ({ page }) => {
    await openCreateHostDialog(page);
    await fillHostBasics(page, { name: 'Functional SSL Redirect Test', domain: DOMAIN, upstream: 'echo-server:8080' });

    // "Redirect HTTP to HTTPS" is on by default for a new host.
    await openEditorSection(page, 'Certificate');
    await expect(page.getByRole('switch', { name: 'Redirect HTTP to HTTPS' })).toHaveAttribute('aria-checked', 'true');
    await saveHostEditor(page);

    await waitForRoute(DOMAIN);
  });

  test('HTTP request receives 308 redirect to HTTPS', async () => {
    const res = await httpGet(DOMAIN, '/');
    // Caddy redirects HTTP→HTTPS when ssl_forced=true
    expect(res.status).toBe(308);
  });

  test('redirect Location header points to HTTPS', async () => {
    const res = await httpGet(DOMAIN, '/');
    expect(res.status).toBe(308);
    const location = res.headers['location'];
    const locationStr = Array.isArray(location) ? location[0] : (location ?? '');
    expect(locationStr).toMatch(/^https:\/\//);
    expect(locationStr).toContain(DOMAIN);
  });

  test('redirect preserves the request path', async () => {
    const res = await httpGet(DOMAIN, '/some/path');
    expect(res.status).toBe(308);
    const location = res.headers['location'];
    const locationStr = Array.isArray(location) ? location[0] : (location ?? '');
    expect(locationStr).toContain('/some/path');
  });
});

/**
 * Functional tests: path prefix rewrite.
 *
 * Creates a proxy host with a path prefix rewrite (/api) pointing at the
 * whoami-server, which reflects the full request line in its response body.
 * This lets us assert that Caddy rewrote the path before forwarding, e.g.
 * a client request for /users arrives at the upstream as /api/users.
 *
 * Domain: func-rewrite.test
 */
import { test, expect } from '@playwright/test';
import { openCreateHostDialog, fillHostBasics, openEditorSection, saveHostEditor, setEditorSwitch } from '../../helpers/proxy-api';
import { httpGet, waitForRoute } from '../../helpers/http';

const DOMAIN = 'func-rewrite.test';

test.describe.serial('Path Prefix Rewrite', () => {
  test('setup: create proxy host with path prefix rewrite', async ({ page }) => {
    // whoami-server listens on port 80 by default
    await openCreateHostDialog(page);
    await fillHostBasics(page, { name: 'Functional Path Prefix Rewrite Test', domain: DOMAIN, upstream: 'whoami-server:80' });

    // The path prefix rewrite field (Advanced section)
    await openEditorSection(page, 'Advanced');
    await page.getByLabel('Path prefix for the upstream').fill('/api');

    // Plain HTTP for the test requests.
    await openEditorSection(page, 'Certificate');
    await setEditorSwitch(page, 'Redirect HTTP to HTTPS', false);
    await saveHostEditor(page);

    await waitForRoute(DOMAIN);
  });

  test('request path is prepended with the prefix before reaching the upstream', async () => {
    const res = await httpGet(DOMAIN, '/users');
    expect(res.status).toBe(200);
    // traefik/whoami echoes the request line, e.g. "GET /api/users HTTP/1.1"
    expect(res.body).toContain('/api/users');
  });

  test('root path is prepended with the prefix', async () => {
    const res = await httpGet(DOMAIN, '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('/api/');
  });

  test('nested path is prepended with the prefix', async () => {
    const res = await httpGet(DOMAIN, '/items/42/details');
    expect(res.status).toBe(200);
    expect(res.body).toContain('/api/items/42/details');
  });

  test('original path without prefix is NOT sent to the upstream', async () => {
    const res = await httpGet(DOMAIN, '/users');
    expect(res.status).toBe(200);
    // The upstream must NOT see the bare /users path — it should see /api/users
    expect(res.body).not.toMatch(/^GET \/users /m);
  });
});

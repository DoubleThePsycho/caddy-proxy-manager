/**
 * Functional tests: per-path redirect rules.
 *
 * Creates a proxy host with structured redirect rules and verifies that
 * Caddy issues the correct redirect responses for matched paths while
 * still proxying unmatched paths to the upstream.
 *
 * The rules are entered in the host editor's Advanced section.
 *
 * Domain: func-redirects.test
 */
import { test, expect } from '@playwright/test';
import { openCreateHostDialog, addRedirect, fillHostBasics, openEditorSection, saveHostEditor, setEditorSwitch } from '../../helpers/proxy-api';
import { httpGet, waitForRoute } from '../../helpers/http';

const DOMAIN = 'func-redirects.test';

test.describe.serial('Per-path Redirect Rules', () => {
  test('setup: create proxy host with redirect rules', async ({ page }) => {
    await openCreateHostDialog(page);
    await fillHostBasics(page, { name: 'Functional Redirects Test', domain: DOMAIN, upstream: 'echo-server:8080' });

    await openEditorSection(page, 'Advanced');
    const rules: Array<{ from: string; to: string; status: 301 | 302 | 307 | 308 }> = [
        { from: '/.well-known/carddav', to: '/remote.php/dav/', status: 301 },
        { from: '/.well-known/caldav',  to: '/remote.php/dav/', status: 302 },
      ];
    for (const rule of rules) await addRedirect(page, rule);

    await openEditorSection(page, 'Certificate');
    await setEditorSwitch(page, 'Redirect HTTP to HTTPS', false);
    await saveHostEditor(page);

    await waitForRoute(DOMAIN);
  });

  test('matched path receives the configured 301 redirect', async () => {
    const res = await httpGet(DOMAIN, '/.well-known/carddav');
    expect(res.status).toBe(301);
  });

  test('301 redirect Location header points to the configured destination', async () => {
    const res = await httpGet(DOMAIN, '/.well-known/carddav');
    const location = res.headers['location'];
    const locationStr = Array.isArray(location) ? location[0] : (location ?? '');
    expect(locationStr).toBe('/remote.php/dav/');
  });

  test('second matched path receives the configured 302 redirect', async () => {
    const res = await httpGet(DOMAIN, '/.well-known/caldav');
    expect(res.status).toBe(302);
  });

  test('302 redirect Location header points to the configured destination', async () => {
    const res = await httpGet(DOMAIN, '/.well-known/caldav');
    const location = res.headers['location'];
    const locationStr = Array.isArray(location) ? location[0] : (location ?? '');
    expect(locationStr).toBe('/remote.php/dav/');
  });

  test('unmatched path is proxied normally to the upstream', async () => {
    const res = await httpGet(DOMAIN, '/some/other/path');
    expect(res.status).toBe(200);
    expect(res.body).toContain('echo-ok');
  });
});

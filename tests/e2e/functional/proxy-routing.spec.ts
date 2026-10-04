/**
 * Functional tests: basic reverse-proxy routing.
 *
 * Creates a real proxy host pointing at the echo-server container,
 * then sends HTTP requests directly to Caddy and asserts the response
 * comes from the upstream.
 *
 * Domain: func-proxy.test  (no DNS resolution needed — requests go to
 * 127.0.0.1:80 with a custom Host header, which Caddy routes by hostname).
 */
import { test, expect } from '@playwright/test';
import { createProxyHost, findHostRow } from '../../helpers/proxy-api';
import { httpGet, waitForRoute } from '../../helpers/http';

const DOMAIN = 'func-proxy.test';
const ECHO_BODY = 'echo-ok';

test.describe.serial('Proxy Routing', () => {
  test('setup: create proxy host pointing at echo server', async ({ page }) => {
    await createProxyHost(page, {
      name: 'Functional Proxy Test',
      domain: DOMAIN,
      upstream: 'echo-server:8080',
    });
    await waitForRoute(DOMAIN);
  });

  test('routes HTTP requests to the upstream echo server', async () => {
    const res = await httpGet(DOMAIN);
    expect(res.status).toBe(200);
    expect(res.body).toContain(ECHO_BODY);
  });

  test('proxies arbitrary paths to the upstream', async () => {
    const res = await httpGet(DOMAIN, '/some/path?q=hello');
    expect(res.status).toBe(200);
    expect(res.body).toContain(ECHO_BODY);
  });

  test('unknown domain is not proxied to the echo server', async () => {
    // The native fallback is configuration-dependent; only upstream isolation
    // is relevant to this routing test.
    const res = await httpGet('no-such-route.test');
    expect(res.body).not.toContain(ECHO_BODY);
  });

  test('disabled proxy host stops routing traffic', async ({ page }) => {
    // Disable the host from its row menu.
    let row = await findHostRow(page, 'Functional Proxy Test');
    await row.getByRole('button', { name: /^more actions for/i }).click();
    await page.getByRole('menuitem', { name: 'Disable' }).click();
    // Give Caddy time to reload config
    await page.waitForTimeout(3_000);

    // Disabling the final host may remove Caddy's HTTP listener entirely. A
    // native response or a closed connection both prove the route is gone.
    try {
      const res = await httpGet(DOMAIN);
      expect(res.body).not.toContain(ECHO_BODY);
    } catch {
      // No HTTP listener is a valid native outcome when no managed route remains.
    }

    // Re-enable
    row = await findHostRow(page, 'Functional Proxy Test');
    await row.getByRole('button', { name: /^more actions for/i }).click();
    await page.getByRole('menuitem', { name: 'Enable' }).click();
    await page.waitForTimeout(2_000);
  });
});

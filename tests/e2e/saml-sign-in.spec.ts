/**
 * E2E tests: SAML 2.0 sign-in (ee/saml) against a real Keycloak (the
 * keycloak service in tests/docker-compose.test.yml, realm imported from
 * tests/keycloak/realm.json).
 *
 * The provider is written straight into the database from the realm's IdP
 * metadata. The spec
 * then registers the matching SAML client in Keycloak through its admin API:
 * persistent NameID, signed responses and assertions (RSA-SHA256), and
 * "email" and "groups" attributes. Everything it creates is removed
 * afterwards, so the login page of later specs is the usual one.
 */
import { test, expect, type Page } from '@playwright/test';
import { webDb, webSql } from '../helpers/e2e-sql';

const BASE = 'http://localhost:3000';
const KEYCLOAK = 'http://localhost:8089';
const REALM = 'ingressi-e2e';
const KEYCLOAK_ADMIN = { username: 'admin', password: 'keycloak-admin-password-2026' };
const PROVIDER_NAME = 'E2E Keycloak';

const USERS = {
  admin: { username: 'e2e-saml-admin', password: 'E2eSamlAdmin2026!', email: 'e2e-saml-admin@example.com' },
  user: { username: 'e2e-saml-user', password: 'E2eSamlUser2026!', email: 'e2e-saml-user@example.com' },
  outsider: { username: 'e2e-saml-outsider', password: 'E2eSamlOutsider2026!', email: 'e2e-saml-outsider@example.com' },
};

/** Removes the provider, its accounts, mappings and state, and the users it created. */
function cleanUp(): void {
  webDb(`
    const emails = ${JSON.stringify(Object.values(USERS).map((user) => user.email))};
    for (const email of emails) {
      const user = await db.get("SELECT id FROM users WHERE email = ?", [email]);
      if (!user) continue;
      for (const table of ["sessions", "accounts", "two_factors"]) await db.run("DELETE FROM " + table + ' WHERE "userId" = ?', [user.id]);
      await db.run("DELETE FROM users WHERE id = ?", [user.id]);
    }
    for (const row of await db.all("SELECT id FROM saml_providers WHERE name = ?", [${JSON.stringify(PROVIDER_NAME)}])) {
      await db.run('DELETE FROM accounts WHERE "providerId" = ?', ["saml:" + row.id]);
      for (const table of ["saml_group_roles", "saml_requests", "saml_used_assertions"]) await db.run("DELETE FROM " + table + ' WHERE "providerId" = ?', [row.id]);
      await db.run("DELETE FROM saml_providers WHERE id = ?", [row.id]);
    }
  `);
}

async function waitForRealm(): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${KEYCLOAK}/realms/${REALM}/protocol/saml/descriptor`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Keycloak did not come up');
}

/** The realm's IdP metadata: entity ID, HTTP-Redirect SSO URL and signing certificates. */
async function realmMetadata(): Promise<{ entityId: string; ssoUrl: string; certificates: string[] }> {
  const xml = await (await fetch(`${KEYCLOAK}/realms/${REALM}/protocol/saml/descriptor`)).text();
  const entityId = /entityID="([^"]+)"/.exec(xml)?.[1];
  const ssoUrl = /<(?:md:)?SingleSignOnService[^>]*Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"[^>]*Location="([^"]+)"/.exec(xml)?.[1];
  const certificates = [...xml.matchAll(/<(?:ds:)?X509Certificate>([^<]+)<\/(?:ds:)?X509Certificate>/g)]
    .map((match) => `-----BEGIN CERTIFICATE-----\n${match[1].replace(/\s+/g, '').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`);
  if (!entityId || !ssoUrl || certificates.length === 0) throw new Error('unexpected Keycloak metadata');
  return { entityId, ssoUrl, certificates: [...new Set(certificates)] };
}

function createProvider(metadata: { entityId: string; ssoUrl: string; certificates: string[] }): number {
  const now = new Date().toISOString();
  const row = {
    name: PROVIDER_NAME,
    enabled: true,
    idpEntityId: metadata.entityId,
    idpSsoUrl: metadata.ssoUrl,
    idpCertificates: JSON.stringify(metadata.certificates),
    emailAttribute: 'email',
    groupsAttribute: 'groups',
    defaultRole: 'user',
    requiredGroup: 'ingressi-users',
    provisionUsers: true,
    linkExistingAccounts: false,
    createdAt: now,
    updatedAt: now,
  };
  const columns = Object.keys(row);
  const [{ id }] = webSql<{ id: number }>(
    `INSERT INTO saml_providers (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING id`,
    columns.map((column) => row[column as keyof typeof row])
  );
  webSql(
    'INSERT INTO saml_group_roles ("providerId", "groupValue", role, "createdAt") VALUES (?, ?, ?, ?)',
    [id, 'ingressi-admins', 'admin', now]
  );
  return Number(id);
}

async function keycloakToken(): Promise<string> {
  const response = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', ...KEYCLOAK_ADMIN }).toString(),
  });
  if (!response.ok) throw new Error(`Keycloak admin token: HTTP ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Registers (or replaces) the SAML client for the provider's SP entity ID. */
async function registerClient(entityId: string, acsUrl: string): Promise<void> {
  const token = await keycloakToken();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const existing = await (await fetch(`${KEYCLOAK}/admin/realms/${REALM}/clients?clientId=${encodeURIComponent(entityId)}`, { headers })).json() as Array<{ id: string }>;
  for (const client of existing) {
    await fetch(`${KEYCLOAK}/admin/realms/${REALM}/clients/${client.id}`, { method: 'DELETE', headers });
  }
  const response = await fetch(`${KEYCLOAK}/admin/realms/${REALM}/clients`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: entityId,
      name: 'Ingressi E2E',
      protocol: 'saml',
      enabled: true,
      frontchannelLogout: false,
      redirectUris: [acsUrl],
      attributes: {
        'saml.authnstatement': 'true',
        'saml.server.signature': 'true',
        'saml.assertion.signature': 'true',
        'saml.signature.algorithm': 'RSA_SHA256',
        'saml.client.signature': 'false',
        'saml.encrypt': 'false',
        'saml_force_name_id_format': 'true',
        'saml_name_id_format': 'persistent',
        'saml_assertion_consumer_url_post': acsUrl,
      },
      protocolMappers: [
        {
          name: 'email',
          protocol: 'saml',
          protocolMapper: 'saml-user-property-mapper',
          config: { 'user.attribute': 'email', 'attribute.name': 'email', 'attribute.nameformat': 'Basic' },
        },
        {
          name: 'groups',
          protocol: 'saml',
          protocolMapper: 'saml-group-membership-mapper',
          config: { 'attribute.name': 'groups', 'full.path': 'false', single: 'false', 'attribute.nameformat': 'Basic' },
        },
      ],
    }),
  });
  if (response.status !== 201) throw new Error(`Keycloak client: HTTP ${response.status} ${await response.text()}`);
}

async function signInWithKeycloak(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: `Continue with ${PROVIDER_NAME}` }).click();
  await page.waitForURL((url) => url.origin === KEYCLOAK, { timeout: 30_000 });
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}

function userRow(email: string): { role: string; providerId: string | null; accountId: string | null } | null {
  return webDb(`
    const user = await db.get("SELECT id, role FROM users WHERE email = ?", [${JSON.stringify(email)}]);
    const account = user ? await db.get('SELECT "providerId", "accountId" FROM accounts WHERE "userId" = ? AND "providerId" LIKE ?', [user.id, "saml:%"]) : null;
    emit(user ? { role: user.role, providerId: account?.providerId ?? null, accountId: account?.accountId ?? null } : null);
  `);
}

test.use({ storageState: { cookies: [], origins: [] } });

test.describe.serial('SAML sign-in with Keycloak', () => {
  let providerId = 0;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    cleanUp();
    await waitForRealm();
    providerId = createProvider(await realmMetadata());
    await registerClient(
      `${BASE}/api/auth/saml/metadata/${providerId}`,
      `${BASE}/api/auth/saml/acs/${providerId}`
    );
  });

  test.afterAll(() => {
    cleanUp();
  });

  test('the login page offers the provider', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await expect(page.getByRole('button', { name: `Continue with ${PROVIDER_NAME}` })).toBeVisible();
  });

  test('a member of the mapped admin group signs in, is provisioned and gets the admin role', async ({ page }) => {
    await signInWithKeycloak(page, USERS.admin.username, USERS.admin.password);
    await page.waitForURL((url) => url.origin === BASE && !url.pathname.includes('/login'), { timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Users and groups', exact: true }).first()).toBeVisible();
    const row = userRow(USERS.admin.email);
    expect(row).toMatchObject({ role: 'admin', providerId: `saml:${providerId}` });
    // Keycloak's persistent NameID (a pseudonym), never the e-mail address.
    expect(row?.accountId).not.toBe(USERS.admin.email);
  });

  test('a member of the required group only gets the default role', async ({ page }) => {
    await signInWithKeycloak(page, USERS.user.username, USERS.user.password);
    await page.waitForURL((url) => url.origin === BASE && !url.pathname.includes('/login'), { timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Users and groups', exact: true })).toHaveCount(0);
    expect(userRow(USERS.user.email)).toMatchObject({ role: 'user' });
  });

  test('a user outside the required group is sent back to the login page with an error', async ({ page }) => {
    await signInWithKeycloak(page, USERS.outsider.username, USERS.outsider.password);
    await page.waitForURL(`${BASE}/login?error=saml`, { timeout: 30_000 });
    await expect(page.getByText('Single sign-on did not complete')).toBeVisible();
    expect(userRow(USERS.outsider.email)).toBeNull();
  });

  test('a response posted without the binding cookie is refused', async ({ page, browser }) => {
    // Start in one browser, finish at the IdP, but capture the POST and replay it from a fresh context.
    let captured: { url: string; body: string } | null = null;
    await page.route(`${BASE}/api/auth/saml/acs/**`, async (route) => {
      captured = { url: route.request().url(), body: route.request().postData() ?? '' };
      await route.abort();
    });
    await signInWithKeycloak(page, USERS.user.username, USERS.user.password).catch(() => undefined);
    await expect.poll(() => captured !== null, { timeout: 30_000 }).toBe(true);

    const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const response = await other.request.post(captured!.url, {
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: KEYCLOAK },
        data: captured!.body,
        maxRedirects: 0,
      });
      expect(response.status()).toBe(302);
      expect(response.headers().location).toBe(`${BASE}/login?error=saml`);
      expect((await other.cookies()).some((cookie) => cookie.name.includes('session_token'))).toBe(false);
    } finally {
      await other.close();
    }
  });

  test('the SP metadata is public', async ({ request }) => {
    const response = await request.get(`${BASE}/api/auth/saml/metadata/${providerId}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/samlmetadata+xml');
    expect(await response.text()).toContain(`entityID="${BASE}/api/auth/saml/metadata/${providerId}"`);
  });
});

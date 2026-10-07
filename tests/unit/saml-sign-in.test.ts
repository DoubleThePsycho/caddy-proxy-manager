/**
 * SAML sign-in (ee/saml) end to end over Better Auth's HTTP handler, with
 * responses signed in-process by a test identity provider: starting a
 * sign-in, the binding cookie and login CSRF, IdP-initiated responses,
 * replay, linking and provisioning, the account id, group-to-role mapping,
 * the required group, enforced SSO, MFA, disabled accounts, and that no
 * Better Auth route manages providers.
 *
 * Like ldap-sign-in.test.ts, this boots the real db module and the real
 * auth-server against the application database: a SQLite file, or in the
 * postgres project the worker's PostgreSQL database (tests/helpers/app-database.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { createVerify } from 'node:crypto';
import { stringify } from 'node:querystring';
import { APP_BASE_URL, AuthBrowser } from '../helpers/mfa-browser';
import {
  EMAIL_FORMAT,
  IDP_ENTITY_ID,
  IDP_SSO_URL,
  PERSISTENT,
  createTestKey,
  newId,
  readAuthnRequest,
  signedResponse,
  type ResponseOptions,
  type TestKey,
} from '../helpers/saml-idp';
import { first as dbFirst } from '@/src/lib/db/ops';
import { openAppDatabase, type AppDatabase } from '../helpers/app-database';

let database: AppDatabase;

const LOCAL_PASSWORD = 'Correct-Horse-9!';
const ERROR_LOCATION = `${APP_BASE_URL}/login?error=saml`;
const ENTRA_OID = 'http://schemas.microsoft.com/identity/claims/objectidentifier';

type App = {
  db: Awaited<typeof import('../../src/lib/db')>['default'];
  schema: typeof import('../../src/lib/db/schema');
  auth: ReturnType<Awaited<typeof import('../../src/lib/auth-server')>['getAuth']>;
  userModel: typeof import('../../src/lib/models/user');
  ssoStore: typeof import('../../ee/sso/enforcement-store');
  audit: typeof import('../../src/lib/audit');
  secret: typeof import('../../src/lib/secret');
  store: typeof import('../../ee/saml/store');
};
let app: App;
let primaryAdminId: number;
let idp: TestKey;

beforeAll(async () => {
  database = await openAppDatabase('ingressi-saml-');
  process.env.BASE_URL = APP_BASE_URL;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  vi.resetModules();

  const dbModule = await import('../../src/lib/db');
  const { getAuth } = await import('../../src/lib/auth-server');
  app = {
    db: dbModule.default,
    schema: await import('../../src/lib/db/schema'),
    auth: getAuth(),
    userModel: await import('../../src/lib/models/user'),
    ssoStore: await import('../../ee/sso/enforcement-store'),
    audit: await import('../../src/lib/audit'),
    secret: await import('../../src/lib/secret'),
    store: await import('../../ee/saml/store'),
  };
  idp = createTestKey('idp.example.com');
  // The first account gets id 1, like the primary admin created from ADMIN_USERNAME.
  primaryAdminId = (await localAccount('root', 'admin', 'root@example.com')).id;
});

afterAll(async () => {
  await database.close();
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  vi.resetModules();
});

const browser = () => new AuthBrowser(() => app.auth.handler);

async function localAccount(username: string, role: 'admin' | 'user' = 'user', email = `${username}@example.com`) {
  return app.userModel.createUser({
    email,
    username,
    role,
    provider: 'credentials',
    subject: username,
    passwordHash: bcrypt.hashSync(LOCAL_PASSWORD, 4),
  });
}

let providerCounter = 0;

type ProviderRow = typeof import('../../src/lib/db/schema').samlProviders.$inferInsert;

/** A provider row as the administration code stores it. */
async function addProvider(overrides: Partial<ProviderRow> = {}, mappings: Array<{ group: string; role: string }> = []): Promise<number> {
  providerCounter += 1;
  const now = new Date().toISOString();
  const row = (await dbFirst(app.db.insert(app.schema.samlProviders).values({
    name: `IdP ${providerCounter}`,
    idpEntityId: IDP_ENTITY_ID,
    idpSsoUrl: IDP_SSO_URL,
    idpCertificates: JSON.stringify([idp.certificate]),
    emailAttribute: 'email',
    nameAttribute: 'name',
    groupsAttribute: 'groups',
    provisionUsers: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).returning()))!;
  for (const mapping of mappings) {
    await app.db.insert(app.schema.samlGroupRoles).values({ providerId: row.id, groupValue: mapping.group, role: mapping.role, createdAt: now });
  }
  return row.id;
}

async function startSignIn(b: AuthBrowser, providerId: number) {
  const res = await b.post('/sign-in/saml', { providerId, callbackURL: '/proxy-hosts' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { ...res, request: readAuthnRequest(res.body.url) };
}

type Identity = Partial<ResponseOptions> & { key?: TestKey; target?: 'assertion' | 'response' | 'both' };

function responseFor(providerId: number, requestId: string | null, identity: Identity = {}): string {
  return signedResponse({
    sp: app.store.serviceProviderUrls(providerId),
    requestId,
    nameId: 'subject-0001',
    attributes: { email: 'saml-user@example.com', name: 'SAML User' },
    key: identity.key ?? idp,
    ...identity,
  });
}

function postResponse(b: AuthBrowser, providerId: number, response: string) {
  return b.postForm(`/saml/acs/${providerId}`, { SAMLResponse: response, RelayState: '' });
}

/** A whole sign-in in one browser. */
async function signIn(providerId: number, identity: Identity = {}, b: AuthBrowser = browser()) {
  const start = await startSignIn(b, providerId);
  const result = await postResponse(b, providerId, responseFor(providerId, start.request.id, identity));
  return { browser: b, start, result };
}

function signedInOk(result: { status: number; location: string | null }, b: AuthBrowser) {
  expect(result.status).toBe(302);
  expect(result.location).toBe(`${APP_BASE_URL}/proxy-hosts`);
  expect(b.has('session_token')).toBe(true);
}

/** A sign-in that must succeed. */
async function signInOk(providerId: number, identity: Identity = {}) {
  const outcome = await signIn(providerId, identity);
  signedInOk(outcome.result, outcome.browser);
  return outcome;
}

function refused(result: { status: number; location: string | null }, b: AuthBrowser) {
  expect(result.status).toBe(302);
  expect(result.location).toBe(ERROR_LOCATION);
  expect(b.has('session_token')).toBe(false);
}

async function userIdForEmail(email: string): Promise<number | undefined> {
  const { eq } = await import('drizzle-orm');
  return (await dbFirst(app.db.select({ id: app.schema.users.id }).from(app.schema.users).where(eq(app.schema.users.email, email)).limit(1)))?.id;
}

async function userRow(id: number) {
  const { eq } = await import('drizzle-orm');
  return (await dbFirst(app.db.select().from(app.schema.users).where(eq(app.schema.users.id, id)).limit(1)))!;
}

async function accountRows(userId: number) {
  const { eq } = await import('drizzle-orm');
  return await app.db.select().from(app.schema.accounts).where(eq(app.schema.accounts.userId, userId));
}

function auditEvents(): Array<{ action: string; userId?: number | null; summary?: string; data?: any }> {
  return vi.mocked(app.audit.logAuditEvent).mock.calls.map(([event]) => event as never);
}

function lastRefusal() {
  return auditEvents().filter((event) => event.action === 'saml_sign_in_refused').pop();
}

let subjectCounter = 0;
/** A unique subject and e-mail address per test. */
function person(prefix: string) {
  subjectCounter += 1;
  return { nameId: `${prefix}-${subjectCounter}`, email: `${prefix}-${subjectCounter}@example.com` };
}

beforeEach(async () => {
  await app.ssoStore.writeSsoEnforcement(app.db, { enabled: false, breakGlassUserIds: [] });
  vi.mocked(app.audit.logAuditEvent).mockClear();
});

describe('starting a sign-in', () => {
  it('sends an unsigned AuthnRequest asking for a persistent NameID, and sets the binding cookie', async () => {
    const id = await addProvider();
    const b = browser();
    const { body, setCookies, request } = await startSignIn(b, id);
    expect(body.redirect).toBe(true);
    expect(body.url.startsWith(`${IDP_SSO_URL}?`)).toBe(true);
    expect(request.params.get('Signature')).toBeNull();
    const sp = app.store.serviceProviderUrls(id);
    expect(request.xml).toContain(`AssertionConsumerServiceURL="${sp.acsUrl}"`);
    expect(request.xml).toContain(`>${sp.entityId}</saml:Issuer>`);
    expect(request.xml).toContain(`Format="${PERSISTENT}"`);
    expect(request.xml).not.toContain('RequestedAuthnContext');
    const cookie = setCookies.find((line) => line.startsWith('__Host-saml_binding='))!;
    expect(cookie).toMatch(/; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=None$/);
    const pending = (await app.db.select().from(app.schema.samlRequests)).filter((row) => row.requestId === request.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].bindingHash).not.toContain(cookie.split(';')[0].split('=')[1]);
  });

  it('signs the AuthnRequest with RSA-SHA256 when the provider has an SP key', async () => {
    const sp = createTestKey('sp.example.com', 2048);
    const id = await addProvider({ spPrivateKey: app.secret.encryptSecret(sp.privateKey), spCertificate: sp.certificate, subjectAttribute: ENTRA_OID });
    const { request } = await startSignIn(browser(), id);
    expect(request.params.get('SigAlg')).toBe('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
    expect(request.xml).not.toContain('Format=');
    const signedPart = stringify({ SAMLRequest: request.params.get('SAMLRequest')!, SigAlg: request.params.get('SigAlg')! });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signedPart);
    expect(verifier.verify(sp.certificate, request.params.get('Signature')!, 'base64')).toBe(true);
  });

  it('refuses an unknown or disabled provider', async () => {
    const disabled = await addProvider({ enabled: false });
    expect((await browser().post('/sign-in/saml', { providerId: disabled })).status).toBe(404);
    expect((await browser().post('/sign-in/saml', { providerId: 999_999 })).status).toBe(404);
  });

  it('keeps the return path on this dashboard', async () => {
    const id = await addProvider();
    for (const callbackURL of ['//evil.example.org/x', '/\\evil.example.org', 'https://evil.example.org/']) {
      const b = browser();
      const res = await b.post('/sign-in/saml', { providerId: id, callbackURL });
      // Better Auth's callbackURL check may refuse it first; otherwise the sign-in returns to "/".
      if (res.status === 403) continue;
      expect(res.status, callbackURL).toBe(200);
      const who = person('return');
      const result = await postResponse(b, id, responseFor(id, readAuthnRequest(res.body.url).id, { nameId: who.nameId, attributes: { email: who.email } }));
      expect(result.location, callbackURL).toBe(`${APP_BASE_URL}/`);
    }
  });
});

describe('a complete sign-in', () => {
  it('creates the account with the asserted e-mail and name, links it by the persistent NameID, and signs in', async () => {
    const id = await addProvider();
    const who = person('new');
    const { browser: b, result } = await signIn(id, { nameId: who.nameId, attributes: { email: who.email, name: 'New Person', role: 'admin' } });
    signedInOk(result, b);
    expect(b.has('saml_binding')).toBe(false);

    const userId = (await userIdForEmail(who.email))!;
    expect(await userRow(userId)).toMatchObject({ name: 'New Person', role: 'user', status: 'active', username: null });
    const [account] = await accountRows(userId);
    expect(account).toMatchObject({ providerId: `saml:${id}`, accountId: who.nameId, issuer: `local:saml:${id}`, password: null });
    expect(auditEvents().map((event) => event.action)).toContain('saml_user_provisioned');

    // The next sign-in uses the same account, even with a new e-mail address.
    const again = await signIn(id, { nameId: who.nameId, attributes: { email: 'renamed@example.com' } });
    signedInOk(again.result, again.browser);
    expect(await accountRows(userId)).toHaveLength(1);
    expect(await userIdForEmail('renamed@example.com')).toBeUndefined();
  });

  it('accepts a response signed only on the Response element', async () => {
    const id = await addProvider();
    const who = person('keycloak');
    const { browser: b, result } = await signIn(id, { ...who, attributes: { email: who.email }, target: 'response' });
    signedInOk(result, b);
  });

  it('serves the SP metadata publicly, for existing providers only', async () => {
    const id = await addProvider();
    const res = await browser().get(`/saml/metadata/${id}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/samlmetadata+xml');
    const sp = app.store.serviceProviderUrls(id);
    expect(res.body).toContain(`entityID="${sp.entityId}"`);
    expect(res.body).toContain(`Location="${sp.acsUrl}"`);
    expect(res.body).toContain('WantAssertionsSigned="true"');
    expect((await browser().get('/saml/metadata/999999')).status).toBe(404);
  });
});

describe('binding the response to the browser that started the sign-in', () => {
  it('refuses a response posted from another browser (no binding cookie)', async () => {
    const id = await addProvider();
    const who = person('csrf');
    const victim = browser();
    const { request } = await startSignIn(browser(), id);
    const result = await postResponse(victim, id, responseFor(id, request.id, { ...who, attributes: { email: who.email } }));
    refused(result, victim);
    expect(lastRefusal()?.data).toMatchObject({ failure: 'binding' });
  });

  it('refuses an attacker\'s response forced into a victim\'s sign-in (login CSRF)', async () => {
    const id = await addProvider();
    const attacker = browser();
    const attackerStart = await startSignIn(attacker, id);
    const attackerResponse = responseFor(id, attackerStart.request.id, { nameId: 'attacker', attributes: { email: 'attacker@example.org' } });

    const victim = browser();
    await startSignIn(victim, id);
    refused(await postResponse(victim, id, attackerResponse), victim);
    expect(lastRefusal()?.data).toMatchObject({ failure: 'in_response_to' });
  });

  it('uses each started sign-in once: a refused attempt cannot be retried with the same cookie', async () => {
    const id = await addProvider();
    const who = person('once');
    const b = browser();
    const { request, setCookies } = await startSignIn(b, id);
    const cookie = setCookies.find((line) => line.startsWith('__Host-saml_binding='))!.split(';')[0].split('=')[1];
    refused(await postResponse(b, id, responseFor(id, newId(), { ...who, attributes: { email: who.email } })), b);
    b.cookies.set('__Host-saml_binding', cookie);
    refused(await postResponse(b, id, responseFor(id, request.id, { ...who, attributes: { email: who.email } })), b);
    expect(lastRefusal()?.data).toMatchObject({ failure: 'binding' });
  });

  it('refuses a cookie of a sign-in started with another provider', async () => {
    const first = await addProvider();
    const second = await addProvider();
    const b = browser();
    const { request } = await startSignIn(b, first);
    refused(await postResponse(b, second, responseFor(second, request.id)), b);
  });

  it('refuses IdP-initiated responses, with or without a started sign-in', async () => {
    const id = await addProvider();
    const who = person('idp-init');
    const cold = browser();
    refused(await postResponse(cold, id, responseFor(id, null, { ...who, attributes: { email: who.email } })), cold);

    const warm = browser();
    await startSignIn(warm, id);
    refused(await postResponse(warm, id, responseFor(id, null, { ...who, attributes: { email: who.email } })), warm);
    expect(lastRefusal()?.data).toMatchObject({ failure: 'idp_initiated' });
  });

  it('refuses a response to another sign-in (wrong InResponseTo)', async () => {
    const id = await addProvider();
    const b = browser();
    await startSignIn(b, id);
    refused(await postResponse(b, id, responseFor(id, newId())), b);
    expect(lastRefusal()?.data).toMatchObject({ failure: 'in_response_to' });
  });
});

describe('replay', () => {
  it('never accepts the same assertion twice', async () => {
    const id = await addProvider();
    const who = person('replay');
    const first = await signIn(id, { ...who, attributes: { email: who.email } });
    signedInOk(first.result, first.browser);
    const response = responseFor(id, first.start.request.id, { ...who, attributes: { email: who.email } });

    // Posted again: the sign-in it answers is used up.
    const again = browser();
    refused(await postResponse(again, id, response), again);

    // An assertion ID used before is refused even inside a response to a new sign-in.
    const assertionId = newId();
    const one = browser();
    const oneStart = await startSignIn(one, id);
    signedInOk(await postResponse(one, id, responseFor(id, oneStart.request.id, { ...who, attributes: { email: who.email }, assertionId })), one);
    const two = browser();
    const twoStart = await startSignIn(two, id);
    refused(await postResponse(two, id, responseFor(id, twoStart.request.id, { ...who, attributes: { email: who.email }, assertionId })), two);
    expect(lastRefusal()?.data).toMatchObject({ failure: 'replayed', assertionId });
  });
});

describe('accounts', () => {
  it('does not create accounts unless the provider provisions users', async () => {
    const id = await addProvider({ provisionUsers: false });
    const who = person('noprov');
    const { browser: b, result } = await signIn(id, { ...who, attributes: { email: who.email } });
    refused(result, b);
    expect(await userIdForEmail(who.email)).toBeUndefined();
    expect(lastRefusal()?.data).toMatchObject({ failure: 'not_provisioned' });
  });

  it('links an existing account with exactly the same e-mail address only when the provider allows it', async () => {
    const local = await localAccount('jack');
    const noLink = await addProvider();
    const { browser: b1, result: r1 } = await signIn(noLink, { nameId: 'jack-subject', attributes: { email: 'JACK@example.com' } });
    refused(r1, b1);
    expect(lastRefusal()?.data).toMatchObject({ failure: 'email_in_use' });
    expect((await accountRows(local.id)).map((a) => a.providerId)).toEqual(['credential']);

    const linking = await addProvider({ linkExistingAccounts: true });
    const { browser: b2, result: r2 } = await signIn(linking, { nameId: 'jack-subject', attributes: { email: 'jack@example.com' } });
    signedInOk(r2, b2);
    expect((await accountRows(local.id)).map((a) => a.providerId).sort()).toEqual(['credential', `saml:${linking}`]);
    expect(auditEvents().map((e) => e.action)).toContain('saml_account_linked');
  });

  it('never links an administrator, a custom-role user, the primary admin or a break-glass account by e-mail', async () => {
    const id = await addProvider({ linkExistingAccounts: true });
    const boss = await localAccount('boss', 'admin');
    const custom = await localAccount('custom');
    const keeper = await localAccount('keeper');
    const { eq } = await import('drizzle-orm');
    await app.db.update(app.schema.users).set({ role: 'viewer', customRoleId: 7 }).where(eq(app.schema.users.id, custom.id));
    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: false, breakGlassUserIds: [keeper.id] });
    const cases: Array<[string, string, string]> = [
      ['boss@example.com', 'boss-subject', 'privileged_account'],
      ['custom@example.com', 'custom-subject', 'privileged_account'],
      ['root@example.com', 'root-subject', 'protected_account'],
      ['keeper@example.com', 'keeper-subject', 'protected_account'],
    ];
    for (const [email, nameId, failure] of cases) {
      const { browser: b, result } = await signIn(id, { nameId, attributes: { email } });
      refused(result, b);
      expect(lastRefusal()?.data, email).toMatchObject({ failure });
    }
    for (const user of [boss, custom, keeper]) expect((await accountRows(user.id)).map((a) => a.providerId)).toEqual(['credential']);
    expect((await accountRows(primaryAdminId)).map((a) => a.providerId)).toEqual(['credential']);
  });

  it('takes the account id from a persistent NameID only', async () => {
    const id = await addProvider();
    const who = person('transient');
    const { browser: b, result } = await signIn(id, { nameId: who.email, nameIdFormat: EMAIL_FORMAT, attributes: { email: who.email } });
    refused(result, b);
    expect(lastRefusal()?.data).toMatchObject({ failure: 'subject_unusable' });
    expect(await userIdForEmail(who.email)).toBeUndefined();
  });

  it('takes the account id from the configured attribute, and from the e-mail only when an administrator chose it', async () => {
    const byOid = await addProvider({ subjectAttribute: ENTRA_OID });
    const who = person('entra');
    const { browser: b, result } = await signIn(byOid, {
      nameId: who.email, nameIdFormat: EMAIL_FORMAT, attributes: { email: who.email, [ENTRA_OID]: '0b8c1b7e-1f0e-4bfa-9d33-2c1a7e2f9a10' },
    });
    signedInOk(result, b);
    expect((await accountRows((await userIdForEmail(who.email))!))[0].accountId).toBe('0b8c1b7e-1f0e-4bfa-9d33-2c1a7e2f9a10');

    // Missing, or several different values: refused.
    const missing = await signIn(byOid, { nameId: 'x', attributes: { email: who.email } });
    refused(missing.result, missing.browser);
    const several = await signIn(byOid, { nameId: 'x', attributes: { email: who.email, [ENTRA_OID]: ['a', 'b'] } });
    refused(several.result, several.browser);

    const byEmail = await addProvider({ subjectAttribute: 'email' });
    const other = person('by-email');
    const signedIn = await signIn(byEmail, { nameId: 'transient-1', nameIdFormat: EMAIL_FORMAT, attributes: { email: other.email } });
    signedInOk(signedIn.result, signedIn.browser);
    expect((await accountRows((await userIdForEmail(other.email))!))[0].accountId).toBe(other.email);
  });

  it('refuses a disabled account', async () => {
    const id = await addProvider();
    const who = person('disabled');
    await signInOk(id, { ...who, attributes: { email: who.email } });
    const { eq } = await import('drizzle-orm');
    const userId = (await userIdForEmail(who.email))!;
    await app.db.update(app.schema.users).set({ status: 'disabled' }).where(eq(app.schema.users.id, userId));
    const { browser: b, result } = await signIn(id, { ...who, attributes: { email: who.email } });
    refused(result, b);
    expect(lastRefusal()?.data).toMatchObject({ failure: 'account_disabled' });
  });
});

describe('group-to-role mapping', () => {
  it('grants roles from mapped groups only, and demotes as well as promotes on every sign-in', async () => {
    const id = await addProvider({}, [{ group: 'ingressi-admins', role: 'admin' }, { group: 'ingressi-readers', role: 'viewer' }]);
    const who = person('mia');
    const first = await signIn(id, { ...who, attributes: { email: who.email, groups: ['staff', 'ingressi-admins'], role: 'viewer' } });
    signedInOk(first.result, first.browser);
    const userId = (await userIdForEmail(who.email))!;
    expect((await userRow(userId)).role).toBe('admin');

    const second = await signIn(id, { ...who, attributes: { email: who.email, groups: ['ingressi-readers'] } });
    signedInOk(second.result, second.browser);
    expect((await userRow(userId)).role).toBe('viewer');

    // No mapped group: the default role.
    const third = await signIn(id, { ...who, attributes: { email: who.email, role: 'admin' } });
    signedInOk(third.result, third.browser);
    expect((await userRow(userId)).role).toBe('user');
    expect(auditEvents().filter((e) => e.action === 'saml_role_changed').map((e) => e.data?.to)).toEqual(['admin', 'viewer', 'user']);
  });

  it('applies the role before the session exists, and takes a custom role away', async () => {
    const id = await addProvider({}, [{ group: 'readers', role: 'viewer' }]);
    const who = person('nora');
    await signInOk(id, { ...who, attributes: { email: who.email, groups: 'readers' } });
    const userId = (await userIdForEmail(who.email))!;
    const { eq } = await import('drizzle-orm');
    await app.db.update(app.schema.users).set({ role: 'viewer', customRoleId: 42 }).where(eq(app.schema.users.id, userId));
    const { browser: b, result } = await signIn(id, { ...who, attributes: { email: who.email, groups: 'readers' } });
    signedInOk(result, b);
    expect(await userRow(userId)).toMatchObject({ role: 'viewer', customRoleId: null });
    const session = await app.db.select().from(app.schema.sessions).where(eq(app.schema.sessions.userId, userId));
    expect(session.length).toBeGreaterThan(0);
  });

  it('leaves roles alone without mappings, and never changes a break-glass account', async () => {
    const plain = await addProvider();
    const who = person('owen');
    await signInOk(plain, { ...who, attributes: { email: who.email } });
    const userId = (await userIdForEmail(who.email))!;
    await app.userModel.updateUserRole(userId, 'admin');
    const again = await signIn(plain, { ...who, attributes: { email: who.email } });
    signedInOk(again.result, again.browser);
    expect((await userRow(userId)).role).toBe('admin');

    const mapped = await addProvider({}, [{ group: 'admins', role: 'admin' }]);
    await app.db.insert(app.schema.accounts).values({
      userId, providerId: `saml:${mapped}`, accountId: who.nameId, issuer: `local:saml:${mapped}`,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: false, breakGlassUserIds: [userId] });
    const guarded = await signIn(mapped, { ...who, attributes: { email: who.email } });
    signedInOk(guarded.result, guarded.browser);
    expect((await userRow(userId)).role).toBe('admin');
  });

  it('never demotes the last active administrator', async () => {
    const id = await addProvider({}, [{ group: 'admins', role: 'admin' }]);
    const who = person('last');
    await signInOk(id, { ...who, attributes: { email: who.email, groups: 'admins' } });
    const userId = (await userIdForEmail(who.email))!;
    const { eq, and, ne } = await import('drizzle-orm');
    const others = (await app.db.select({ id: app.schema.users.id }).from(app.schema.users)
      .where(and(eq(app.schema.users.role, 'admin'), eq(app.schema.users.status, 'active'), ne(app.schema.users.id, userId)))).map((row) => row.id);
    for (const other of others) await app.db.update(app.schema.users).set({ status: 'disabled' }).where(eq(app.schema.users.id, other));
    try {
      const { browser: b, result } = await signIn(id, { ...who, attributes: { email: who.email, groups: [] } });
      signedInOk(result, b);
      expect((await userRow(userId)).role).toBe('admin');
      expect(auditEvents().map((e) => e.action)).toContain('saml_role_change_skipped');
    } finally {
      for (const other of others) await app.db.update(app.schema.users).set({ status: 'active' }).where(eq(app.schema.users.id, other));
    }
  });

  it('refuses users without the required group', async () => {
    const id = await addProvider({ requiredGroup: 'ingressi-users' });
    const who = person('pia');
    const outside = await signIn(id, { ...who, attributes: { email: who.email, groups: ['other'] } });
    refused(outside.result, outside.browser);
    expect(lastRefusal()?.data).toMatchObject({ failure: 'not_in_required_group' });
    expect(await userIdForEmail(who.email)).toBeUndefined();
    const inside = await signIn(id, { ...who, attributes: { email: who.email, groups: ['ingressi-users'] } });
    signedInOk(inside.result, inside.browser);
  });
});

describe('enforced SSO', () => {
  it('admits SAML sign-ins and keeps refusing the same account\'s password', async () => {
    const id = await addProvider({ linkExistingAccounts: true });
    await localAccount('walt');
    await signInOk(id, { nameId: 'walt-subject', attributes: { email: 'walt@example.com' } });
    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: true, breakGlassUserIds: [primaryAdminId] });
    expect((await browser().post('/sign-in/username', { username: 'walt', password: LOCAL_PASSWORD })).status).toBe(401);
    const { browser: b, result } = await signIn(id, { nameId: 'walt-subject', attributes: { email: 'walt@example.com' } });
    signedInOk(result, b);
  });
});

describe('multi-factor authentication', () => {
  it('signs an account with MFA in without a local code, like OAuth sign-in', async () => {
    const id = await addProvider();
    const who = person('mfa');
    await signInOk(id, { ...who, attributes: { email: who.email } });
    const userId = (await userIdForEmail(who.email))!;
    const { eq } = await import('drizzle-orm');
    await app.db.update(app.schema.users).set({ twoFactorEnabled: true }).where(eq(app.schema.users.id, userId));
    const { browser: b, result } = await signIn(id, { ...who, attributes: { email: who.email } });
    signedInOk(result, b);
    expect(b.has('two_factor')).toBe(false);
  });
});

describe('SCIM-provisioned accounts', () => {
  it('links the first sign-in through the SCIM sign-in provider on the externalId attribute', async () => {
    const { setScimSettings } = await import('../helpers/scim');
    const id = await addProvider({ provisionUsers: false, subjectAttribute: ENTRA_OID });
    const scimUser = await localAccount('scimmed');
    const now = new Date().toISOString();
    await app.db.insert(app.schema.scimUsers).values({
      userId: scimUser.id, userName: 'scimmed@example.com', userNameKey: 'scimmed@example.com', externalId: 'oid-scimmed',
      createdAt: now, updatedAt: now,
    });
    await setScimSettings(app.db as never, { providerId: `saml:${id}`, externalIdClaim: ENTRA_OID });

    const wrong = await signIn(id, { nameId: 'n', attributes: { email: 'scimmed@example.com', [ENTRA_OID]: 'oid-other' } });
    refused(wrong.result, wrong.browser);
    const { browser: b, result } = await signIn(id, { nameId: 'n', attributes: { email: 'scimmed@example.com', [ENTRA_OID]: 'oid-scimmed' } });
    signedInOk(result, b);
    expect((await accountRows(scimUser.id)).map((a) => a.providerId).sort()).toEqual(['credential', `saml:${id}`]);
    expect(auditEvents().map((e) => e.action)).toContain('scim_sso_link');
  });
});

describe('provider management is not a Better Auth route', () => {
  it('answers 404 to every library-style management route, for a signed-in user', async () => {
    const id = await addProvider({}, []);
    const who = person('viewer');
    const { browser: b, result } = await signIn(id, { ...who, attributes: { email: who.email } });
    signedInOk(result, b);
    const userId = (await userIdForEmail(who.email))!;
    await app.userModel.updateUserRole(userId, 'viewer');
    const before = (await app.db.select().from(app.schema.samlProviders)).length;

    for (const path of [
      '/sso/register', '/sso/update-provider', '/sso/delete-provider', '/sso/request-domain-verification', '/sso/verify-domain',
      '/saml/register', '/saml/providers', '/saml/provider', `/saml/providers/${id}`, '/sign-in/sso',
    ]) {
      const res = await b.post(path, { providerId: 'evil', issuer: 'https://evil.example.org', samlConfig: {} });
      expect(res.status, path).toBe(404);
    }
    for (const path of ['/sso/providers', '/sso/get-provider', '/saml/providers']) {
      expect((await b.get(path)).status, path).toBe(404);
    }
    expect((await app.db.select().from(app.schema.samlProviders)).length).toBe(before);

    const samlPaths = Object.values(app.auth.api as Record<string, { path?: string }>)
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => typeof path === 'string' && (path.includes('saml') || path.startsWith('/sso')))
      .sort();
    expect(samlPaths).toEqual(['/saml/acs/:providerId', '/saml/metadata/:providerId', '/sign-in/saml']);
  });
});

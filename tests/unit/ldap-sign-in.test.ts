/**
 * LDAP / Active Directory sign-in (ee/ldap) end to end over Better Auth's
 * HTTP handler, against an in-memory directory behind a fake ldapts client:
 * the search-then-bind flow, filter escaping, empty passwords, unknown users
 * versus wrong passwords, linking and provisioning, group-to-role mapping,
 * MFA, enforced SSO and TLS settings.
 *
 * Like auth-mfa.test.ts, this boots the real db module and the real
 * auth-server against the application database: a SQLite file, or in the
 * postgres project the worker's PostgreSQL database (tests/helpers/app-database.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { APP_BASE_URL, AuthBrowser, totpCode, totpSecretFromUri } from '../helpers/mfa-browser';
import { fakeLdap, group, person } from '../helpers/fake-ldap';
import { first as dbFirst } from '@/src/lib/db/ops';
import { openAppDatabase, type AppDatabase } from '../helpers/app-database';

vi.mock('ldapts', async (importOriginal) => {
  const { fakeLdapModule } = await import('../helpers/fake-ldap');
  return fakeLdapModule(await importOriginal<typeof import('ldapts')>());
});

let database: AppDatabase;

const LOCAL_PASSWORD = 'Correct-Horse-9!';
const INVALID = { code: 'INVALID_USERNAME_OR_PASSWORD', message: 'Invalid username or password' };

type App = {
  db: Awaited<typeof import('../../src/lib/db')>['default'];
  schema: typeof import('../../src/lib/db/schema');
  auth: ReturnType<Awaited<typeof import('../../src/lib/auth-server')>['getAuth']>;
  userModel: typeof import('../../src/lib/models/user');
  mfa: typeof import('../../src/lib/mfa');
  mfaAuth: typeof import('../../src/lib/mfa-auth');
  ssoStore: typeof import('../../ee/sso/enforcement-store');
  audit: typeof import('../../src/lib/audit');
  secret: typeof import('../../src/lib/secret');
  plugin: typeof import('../../ee/ldap/plugin');
};
let app: App;
let primaryAdminId: number;

beforeAll(async () => {
  database = await openAppDatabase('ingressi-ldap-');
  process.env.BASE_URL = APP_BASE_URL;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  // The login limiter is covered in ldap-units.test.ts; here every failure would share one client.
  process.env.LOGIN_MAX_ATTEMPTS = '100000';
  vi.resetModules();

  const dbModule = await import('../../src/lib/db');
  const { getAuth } = await import('../../src/lib/auth-server');
  app = {
    db: dbModule.default,
    schema: await import('../../src/lib/db/schema'),
    auth: getAuth(),
    userModel: await import('../../src/lib/models/user'),
    mfa: await import('../../src/lib/mfa'),
    mfaAuth: await import('../../src/lib/mfa-auth'),
    ssoStore: await import('../../ee/sso/enforcement-store'),
    audit: await import('../../src/lib/audit'),
    secret: await import('../../src/lib/secret'),
    plugin: await import('../../ee/ldap/plugin'),
  };
  // The first account gets id 1, like the primary admin created from ADMIN_USERNAME.
  primaryAdminId = (await localAccount('root', 'admin', 'root@example.com')).id;
});

afterAll(async () => {
  await database.close();
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  delete process.env.LOGIN_MAX_ATTEMPTS;
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

let directoryCounter = 0;

/** A directory row as the administration code stores it. */
async function addDirectory(overrides: Partial<typeof import('../../src/lib/db/schema').ldapDirectories.$inferInsert> = {}): Promise<number> {
  directoryCounter += 1;
  const now = new Date().toISOString();
  const row = (await dbFirst(app.db.insert(app.schema.ldapDirectories).values({
    name: `Directory ${directoryCounter}`,
    url: 'ldaps://ldap.example.com:636',
    bindDn: fakeLdap.serviceDn,
    bindPassword: app.secret.encryptSecret(fakeLdap.servicePassword),
    userSearchBase: 'ou=people,dc=example,dc=com',
    userSearchFilter: '(&(objectClass=inetOrgPerson)(uid={username}))',
    provisionUsers: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).returning()))!;
  return row.id;
}

/** A directory that maps groups to roles with a group search. */
async function addMappedDirectory(overrides: Parameters<typeof addDirectory>[0] = {}): Promise<number> {
  return await addDirectory({
    groupMode: 'search',
    groupSearchBase: 'ou=groups,dc=example,dc=com',
    groupSearchFilter: '(&(objectClass=groupOfNames)(member={dn}))',
    groupRoleMappings: JSON.stringify([
      { group: 'cn=admins,ou=groups,dc=example,dc=com', role: 'admin' },
      { group: 'cn=readers,ou=groups,dc=example,dc=com', role: 'viewer' },
    ]),
    ...overrides,
  });
}

async function signIn(b: AuthBrowser, directoryId: number, username: string, password: string) {
  return b.post('/sign-in/ldap', { directoryId, username, password });
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

function auditActions(): Array<{ action: string; userId?: number | null; summary?: string; data?: any }> {
  return vi.mocked(app.audit.logAuditEvent).mock.calls.map(([event]) => event as never);
}

beforeEach(async () => {
  const { eq } = await import('drizzle-orm');
  fakeLdap.reset();
  await app.ssoStore.writeSsoEnforcement(app.db, { enabled: false, breakGlassUserIds: [] });
  await app.db.delete(app.schema.settings).where(eq(app.schema.settings.key, app.mfa.MFA_POLICY_SETTING_KEY));
  await app.mfaAuth.resetMfaRequestStateForTests();
  vi.mocked(app.audit.logAuditEvent).mockClear();
});

describe('search, then bind as the entry found', () => {
  it('signs a new user in: service bind, escaped search, bind as the entry DN, account created and linked by unique id', async () => {
    const id = await addDirectory();
    const alice = person('alice', { cn: 'Alice Liddell', uuid: '6f1d2a3b-0c4e-4b5a-9d8e-7f6a5b4c3d2e' });
    fakeLdap.entries.push(alice);

    const b = browser();
    const res = await signIn(b, id, 'alice', 'alice-password');
    expect(res.status).toBe(200);
    expect(res.body.twoFactorRedirect).toBeUndefined();
    expect(b.has('session_token')).toBe(true);

    expect(fakeLdap.binds()).toEqual([
      { dn: fakeLdap.serviceDn, password: fakeLdap.servicePassword },
      { dn: alice.dn, password: 'alice-password' },
    ]);
    expect(fakeLdap.searches()[0]).toMatchObject({
      base: 'ou=people,dc=example,dc=com',
      filter: '(&(objectClass=inetOrgPerson)(uid=alice))',
      options: { scope: 'sub', sizeLimit: 2, derefAliases: 'never' },
    });

    const userId = (await userIdForEmail('alice@example.com'))!;
    const user = await userRow(userId);
    expect(user).toMatchObject({ name: 'Alice Liddell', role: 'user', status: 'active', username: null });
    const [account] = await accountRows(userId);
    // The stable unique id, never the DN; a namespace of its own.
    expect(account).toMatchObject({
      providerId: `ldap:${id}`,
      accountId: '6f1d2a3b-0c4e-4b5a-9d8e-7f6a5b4c3d2e',
      issuer: `local:ldap:${id}`,
      password: null,
    });
    expect(auditActions().map((event) => event.action)).toContain('ldap_user_provisioned');

    // The next sign-in uses the same account, even after the entry was renamed.
    alice.dn = 'uid=alice,ou=staff,ou=people,dc=example,dc=com';
    const again = await signIn(browser(), id, 'alice', 'alice-password');
    expect(again.status).toBe(200);
    expect(await accountRows(userId)).toHaveLength(1);
  });

  it('escapes the typed username per RFC 4515 and never builds a DN from it', async () => {
    const id = await addDirectory();
    fakeLdap.entries.push(person('bob'));
    const res = await signIn(browser(), id, '*)(uid=*', 'bob-password');
    expect(res).toMatchObject({ status: 401, body: INVALID });
    expect(fakeLdap.searches()[0].filter).toBe('(&(objectClass=inetOrgPerson)(uid=\\2a\\29\\28uid=\\2a))');
    for (const bind of fakeLdap.binds()) expect(bind.dn).not.toContain('*');
  });

  it('refuses an empty or blank password before anything reaches the directory (unauthenticated bind)', async () => {
    const id = await addDirectory();
    fakeLdap.entries.push(person('carol'));
    for (const password of ['', '   ', '\t']) {
      const res = await signIn(browser(), id, 'carol', password);
      expect(res).toMatchObject({ status: 401, body: INVALID });
    }
    expect(fakeLdap.calls).toEqual([]);
  });

  it('answers an unknown user exactly like a wrong password, and binds in both cases', async () => {
    const id = await addDirectory();
    const dave = person('dave');
    fakeLdap.entries.push(dave);

    const wrong = await signIn(browser(), id, 'dave', 'not-the-password');
    const wrongBinds = fakeLdap.binds().length;
    const unknown = await signIn(browser(), id, 'nobody', 'not-the-password');

    expect(wrong).toMatchObject({ status: 401, body: INVALID });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
    expect(wrongBinds).toBe(2);
    // The unknown user also got a service bind and a (failing) user bind, to a DN that does not exist.
    const binds = fakeLdap.binds().slice(wrongBinds);
    expect(binds).toHaveLength(2);
    expect(binds[1].dn).toMatch(/^cn=[0-9a-f-]{36},ou=people,dc=example,dc=com$/);
    expect(binds.map((bind) => bind.dn)).not.toContain(dave.dn);
    expect(await userIdForEmail('dave@example.com')).toBeUndefined();
  });

  it('refuses a username that matches several entries without binding as any of them', async () => {
    const id = await addDirectory({ userSearchFilter: '(&(objectClass=inetOrgPerson)(cn={username}))' });
    const first = person('erin1', { cn: 'Erin' });
    const second = person('erin2', { cn: 'Erin' });
    fakeLdap.entries.push(first, second);
    const res = await signIn(browser(), id, 'Erin', 'erin1-password');
    expect(res).toMatchObject({ status: 401, body: INVALID });
    const dns = fakeLdap.binds().map((bind) => bind.dn);
    expect(dns).not.toContain(first.dn);
    expect(dns).not.toContain(second.dn);
  });

  it('answers 503 only when the directory cannot be reached, whatever the credentials', async () => {
    const id = await addDirectory();
    fakeLdap.entries.push(person('frank'));
    fakeLdap.unreachable = true;
    const res = await signIn(browser(), id, 'frank', 'frank-password');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'DIRECTORY_UNAVAILABLE' });
  });

  it('refuses a disabled directory and an unknown one like a wrong password', async () => {
    const id = await addDirectory({ enabled: false });
    fakeLdap.entries.push(person('gina'));
    expect(await signIn(browser(), id, 'gina', 'gina-password')).toMatchObject({ status: 401, body: INVALID });
    expect(await signIn(browser(), 999_999, 'gina', 'gina-password')).toMatchObject({ status: 401, body: INVALID });
    expect(fakeLdap.calls).toEqual([]);
  });

  it('refuses a disabled account like a wrong password', async () => {
    const id = await addDirectory();
    fakeLdap.entries.push(person('hank'));
    expect((await signIn(browser(), id, 'hank', 'hank-password')).status).toBe(200);
    const { eq } = await import('drizzle-orm');
    const userId = (await userIdForEmail('hank@example.com'))!;
    await app.db.update(app.schema.users).set({ status: 'disabled' }).where(eq(app.schema.users.id, userId));
    const b = browser();
    expect(await signIn(b, id, 'hank', 'hank-password')).toMatchObject({ status: 401, body: INVALID });
    expect(b.has('session_token')).toBe(false);
  });
});

describe('local accounts', () => {
  it('does not create accounts unless the directory provisions users', async () => {
    const id = await addDirectory({ provisionUsers: false });
    fakeLdap.entries.push(person('ivy'));
    expect(await signIn(browser(), id, 'ivy', 'ivy-password')).toMatchObject({ status: 401, body: INVALID });
    expect(await userIdForEmail('ivy@example.com')).toBeUndefined();
    expect(auditActions()).toContainEqual(expect.objectContaining({ action: 'ldap_sign_in_refused' }));
  });

  it('links an existing account with exactly the same e-mail address only when the directory allows it', async () => {
    const local = await localAccount('jack');
    fakeLdap.entries.push(person('jack', { mail: 'JACK@example.com' }));

    const noLink = await addDirectory();
    expect(await signIn(browser(), noLink, 'jack', 'jack-password')).toMatchObject({ status: 401, body: INVALID });
    expect(auditActions().find((e) => e.action === 'ldap_sign_in_refused')?.data?.reason).toMatch(/does not link/);
    expect((await accountRows(local.id)).map((a) => a.providerId)).toEqual(['credential']);

    const linking = await addDirectory({ linkExistingAccounts: true });
    const b = browser();
    expect((await signIn(b, linking, 'jack', 'jack-password')).status).toBe(200);
    expect((await accountRows(local.id)).map((a) => a.providerId).sort()).toEqual(['credential', `ldap:${linking}`]);
    expect(auditActions().map((e) => e.action)).toContain('ldap_account_linked');
  });

  it('never links an administrator or a custom-role user by e-mail', async () => {
    const id = await addDirectory({ linkExistingAccounts: true });
    const boss = await localAccount('boss', 'admin');
    const custom = await localAccount('custom');
    const { eq } = await import('drizzle-orm');
    await app.db.update(app.schema.users).set({ role: 'viewer', customRoleId: 7 }).where(eq(app.schema.users.id, custom.id));
    fakeLdap.entries.push(person('bossclone', { mail: 'boss@example.com' }), person('customclone', { mail: 'custom@example.com' }));
    expect(await signIn(browser(), id, 'bossclone', 'bossclone-password')).toMatchObject({ status: 401, body: INVALID });
    expect(await signIn(browser(), id, 'customclone', 'customclone-password')).toMatchObject({ status: 401, body: INVALID });
    expect((await accountRows(boss.id)).map((a) => a.providerId)).toEqual(['credential']);
    expect((await accountRows(custom.id)).map((a) => a.providerId)).toEqual(['credential']);
    expect(auditActions().filter((e) => e.action === 'ldap_sign_in_refused').map((e) => e.data?.reason))
      .toEqual([expect.stringMatching(/administrator/), expect.stringMatching(/administrator/)]);
  });

  it('never links the primary admin or a break-glass account', async () => {
    const id = await addDirectory({ linkExistingAccounts: true });
    fakeLdap.entries.push(person('rootclone', { mail: 'root@example.com' }));
    expect(await signIn(browser(), id, 'rootclone', 'rootclone-password')).toMatchObject({ status: 401, body: INVALID });
    expect((await accountRows(primaryAdminId)).map((a) => a.providerId)).toEqual(['credential']);

    const keeper = await localAccount('keeper');
    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: false, breakGlassUserIds: [keeper.id] });
    fakeLdap.entries.push(person('keeperclone', { mail: 'keeper@example.com' }));
    expect(await signIn(browser(), id, 'keeperclone', 'keeperclone-password')).toMatchObject({ status: 401, body: INVALID });
    expect((await accountRows(keeper.id)).map((a) => a.providerId)).toEqual(['credential']);
  });

  it('cannot provision an entry without an e-mail address', async () => {
    const id = await addDirectory();
    fakeLdap.entries.push(person('kim', { mail: null }));
    expect(await signIn(browser(), id, 'kim', 'kim-password')).toMatchObject({ status: 401, body: INVALID });
  });

  it('takes the e-mail address and the name from the attributes the administrator chose, as returned', async () => {
    const id = await addDirectory({ emailAttribute: 'workMail', displayNameAttribute: 'displayName' });
    const entry = person('lena', { mail: 'private@example.org' });
    entry.attributes.workMail = 'lena.work@example.com';
    entry.attributes.displayName = 'Lena W.';
    fakeLdap.entries.push(entry);
    expect((await signIn(browser(), id, 'lena', 'lena-password')).status).toBe(200);
    expect(await userIdForEmail('private@example.org')).toBeUndefined();
    const user = await userRow((await userIdForEmail('lena.work@example.com'))!);
    expect(user.name).toBe('Lena W.');
  });
});

describe('group-to-role mapping', () => {
  it('grants roles from mapped groups only, and demotes as well as promotes on every sign-in', async () => {
    const id = await addMappedDirectory();
    const mia = person('mia');
    // An attribute named role is never read.
    mia.attributes.role = 'admin';
    const admins = group('admins', [mia.dn]);
    fakeLdap.entries.push(mia, admins, group('readers', []));

    expect((await signIn(browser(), id, 'mia', 'mia-password')).status).toBe(200);
    const userId = (await userIdForEmail('mia@example.com'))!;
    expect((await userRow(userId)).role).toBe('admin');
    expect(fakeLdap.searches()[1]).toMatchObject({
      base: 'ou=groups,dc=example,dc=com',
      filter: `(&(objectClass=groupOfNames)(member=uid=mia,ou=people,dc=example,dc=com))`,
    });

    admins.attributes.member = [];
    expect((await signIn(browser(), id, 'mia', 'mia-password')).status).toBe(200);
    expect((await userRow(userId)).role).toBe('user');
    expect(auditActions().filter((e) => e.action === 'ldap_role_changed').map((e) => e.data?.to)).toEqual(['admin', 'user']);
  });

  it('takes a custom role away when the directory decides roles', async () => {
    const id = await addMappedDirectory();
    const nora = person('nora');
    fakeLdap.entries.push(nora, group('readers', [nora.dn]));
    expect((await signIn(browser(), id, 'nora', 'nora-password')).status).toBe(200);
    const userId = (await userIdForEmail('nora@example.com'))!;
    const { eq } = await import('drizzle-orm');
    await app.db.update(app.schema.users).set({ role: 'viewer', customRoleId: 42 }).where(eq(app.schema.users.id, userId));
    expect((await signIn(browser(), id, 'nora', 'nora-password')).status).toBe(200);
    expect(await userRow(userId)).toMatchObject({ role: 'viewer', customRoleId: null });
  });

  it('leaves roles alone without mappings, and never changes a break-glass account', async () => {
    const plain = await addDirectory({ groupMode: 'member_of' });
    const owen = person('owen');
    fakeLdap.entries.push(owen);
    expect((await signIn(browser(), plain, 'owen', 'owen-password')).status).toBe(200);
    const userId = (await userIdForEmail('owen@example.com'))!;
    await app.userModel.updateUserRole(userId, 'admin');
    expect((await signIn(browser(), plain, 'owen', 'owen-password')).status).toBe(200);
    expect((await userRow(userId)).role).toBe('admin');

    // Linked to a mapping directory too, but on the break-glass list: untouched.
    const mapped = await addMappedDirectory({ linkExistingAccounts: true });
    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: false, breakGlassUserIds: [userId] });
    const { eq } = await import('drizzle-orm');
    await app.db.insert(app.schema.accounts).values({
      userId, providerId: `ldap:${mapped}`, accountId: String(owen.attributes.entryUUID), issuer: `local:ldap:${mapped}`,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    expect((await signIn(browser(), mapped, 'owen', 'owen-password')).status).toBe(200);
    expect((await userRow(userId)).role).toBe('admin');
    await app.db.delete(app.schema.accounts).where(eq(app.schema.accounts.providerId, `ldap:${mapped}`));
  });

  it('refuses users outside the required group like a wrong password', async () => {
    const id = await addMappedDirectory({ requiredGroup: 'cn=ingressi-users,ou=groups,dc=example,dc=com' });
    const pia = person('pia');
    const members = group('ingressi-users', []);
    fakeLdap.entries.push(pia, members);
    expect(await signIn(browser(), id, 'pia', 'pia-password')).toMatchObject({ status: 401, body: INVALID });
    expect(auditActions().find((e) => e.action === 'ldap_sign_in_refused')?.data?.reason).toMatch(/required group/);
    members.attributes.member = [pia.dn];
    expect((await signIn(browser(), id, 'pia', 'pia-password')).status).toBe(200);
  });

  it('follows nested Active Directory groups with LDAP_MATCHING_RULE_IN_CHAIN', async () => {
    const id = await addDirectory({
      groupMode: 'member_of',
      nestedGroups: true,
      groupSearchBase: 'ou=groups,dc=example,dc=com',
      groupRoleMappings: JSON.stringify([{ group: 'CN=Admins, OU=Groups, DC=example, DC=com', role: 'admin' }]),
    });
    const quinn = person('quinn');
    fakeLdap.entries.push(quinn, group('team', [quinn.dn]), group('admins', ['cn=team,ou=groups,dc=example,dc=com']));
    expect((await signIn(browser(), id, 'quinn', 'quinn-password')).status).toBe(200);
    expect((await userRow((await userIdForEmail('quinn@example.com'))!)).role).toBe('admin');
    expect(fakeLdap.searches()[1].filter).toBe('(member:1.2.840.113556.1.4.1941:=uid=quinn,ou=people,dc=example,dc=com)');
  });
});

describe('multi-factor authentication', () => {
  it('asks a user with MFA for the second factor after a directory sign-in, like a password sign-in', async () => {
    const id = await addDirectory();
    fakeLdap.entries.push(person('rose'));
    const first = browser();
    expect((await signIn(first, id, 'rose', 'rose-password')).status).toBe(200);
    const userId = (await userIdForEmail('rose@example.com'))!;
    expect((await app.mfa.getMfaStatus(userId)).hasPassword).toBe(true);

    // An account without a local password confirms MFA changes with its directory password.
    expect((await first.post('/two-factor/enable', { password: 'wrong' })).status).toBe(400);
    const enable = await first.post('/two-factor/enable', { password: 'rose-password' });
    expect(enable.status).toBe(200);
    const secret = totpSecretFromUri(enable.body.totpURI);
    expect((await first.post('/two-factor/verify-totp', { code: await totpCode(secret) })).status).toBe(200);
    expect(await app.mfa.isMfaEnabled(app.db, userId)).toBe(true);

    const b = browser();
    const res = await signIn(b, id, 'rose', 'rose-password');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ twoFactorRedirect: true });
    expect(b.has('session_token')).toBe(false);
    expect(b.has('two_factor')).toBe(true);

    let verify = await b.post('/two-factor/verify-totp', { code: await totpCode(secret) });
    if (verify.status !== 200) verify = await b.post('/two-factor/verify-totp', { code: await totpCode(secret, 1) });
    expect(verify.status).toBe(200);
    expect(b.has('session_token')).toBe(true);
  });

  it('applies the MFA policy to accounts that sign in with a directory password', async () => {
    const id = await addDirectory();
    fakeLdap.entries.push(person('sam'));
    expect((await signIn(browser(), id, 'sam', 'sam-password')).status).toBe(200);
    const userId = (await userIdForEmail('sam@example.com'))!;
    await app.mfa.updateMfaPolicy({ scope: 'password_users', graceDays: 0 }, primaryAdminId);
    expect(await app.mfa.isMfaRequiredFor(app.db, userId)).toBe(true);
    expect((await app.mfa.getMfaStatus(userId)).gate).toBe('required');
    // A disabled directory is no way in, so the policy no longer covers the account.
    const { eq } = await import('drizzle-orm');
    await app.db.update(app.schema.ldapDirectories).set({ enabled: false }).where(eq(app.schema.ldapDirectories.id, id));
    expect(await app.mfa.isMfaRequiredFor(app.db, userId)).toBe(false);
  });

  it('still refuses MFA setup for an account with neither a local nor a directory password', async () => {
    const id = await addDirectory();
    fakeLdap.entries.push(person('tara'));
    const b = browser();
    expect((await signIn(b, id, 'tara', 'tara-password')).status).toBe(200);
    const { eq } = await import('drizzle-orm');
    await app.db.update(app.schema.ldapDirectories).set({ enabled: false }).where(eq(app.schema.ldapDirectories.id, id));
    expect((await b.post('/two-factor/enable', { password: 'tara-password' })).status).toBe(400);
  });

  it('finds the two-factor plugin hook, and fails closed without it', async () => {
    const { createTwoFactorPlugin } = app.mfaAuth;
    expect(app.plugin.findSecondFactorHook(createTwoFactorPlugin())).toBeTypeOf('function');
    expect(app.plugin.findSecondFactorHook({ id: 'other' } as never)).toBeNull();
  });
});

describe('enforced SSO', () => {
  it('refuses directory sign-in by default, before contacting the directory', async () => {
    const id = await addDirectory();
    fakeLdap.entries.push(person('uma'));
    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: true, breakGlassUserIds: [primaryAdminId] });
    const b = browser();
    expect(await signIn(b, id, 'uma', 'uma-password')).toMatchObject({ status: 401, body: INVALID });
    expect(b.has('session_token')).toBe(false);
    expect(fakeLdap.calls).toEqual([]);
  });

  it('admits a directory that is explicitly open while SSO is enforced, second factor included', async () => {
    const id = await addDirectory({ allowWhenSsoEnforced: true });
    fakeLdap.entries.push(person('vera'));
    const first = browser();
    expect((await signIn(first, id, 'vera', 'vera-password')).status).toBe(200);
    const enable = await first.post('/two-factor/enable', { password: 'vera-password' });
    const secret = totpSecretFromUri(enable.body.totpURI);
    expect((await first.post('/two-factor/verify-totp', { code: await totpCode(secret) })).status).toBe(200);

    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: true, breakGlassUserIds: [primaryAdminId] });
    const b = browser();
    expect((await signIn(b, id, 'vera', 'vera-password')).body).toMatchObject({ twoFactorRedirect: true });
    let verify = await b.post('/two-factor/verify-totp', { code: await totpCode(secret) });
    if (verify.status !== 200) verify = await b.post('/two-factor/verify-totp', { code: await totpCode(secret, 1) });
    expect(verify.status).toBe(200);
    expect(b.has('session_token')).toBe(true);
  });

  it('keeps refusing the local password of a user linked to an open directory', async () => {
    const id = await addDirectory({ allowWhenSsoEnforced: true, linkExistingAccounts: true });
    await localAccount('walt');
    fakeLdap.entries.push(person('walt'));
    expect((await signIn(browser(), id, 'walt', 'walt-password')).status).toBe(200);
    await app.ssoStore.writeSsoEnforcement(app.db, { enabled: true, breakGlassUserIds: [primaryAdminId] });
    expect((await browser().post('/sign-in/username', { username: 'walt', password: LOCAL_PASSWORD })).status).toBe(401);
    expect((await signIn(browser(), id, 'walt', 'walt-password')).status).toBe(200);
  });
});

describe('transport', () => {
  it('passes verified TLS options for ldaps:// and upgrades ldap:// with StartTLS before binding', async () => {
    const ca = 'test-ca-pem';
    const secure = await addDirectory({ url: 'ldaps://ldap.example.com:636', caCertificate: ca });
    fakeLdap.entries.push(person('xena'));
    expect((await signIn(browser(), secure, 'xena', 'xena-password')).status).toBe(200);
    const construct = fakeLdap.calls.find((call) => call.op === 'construct') as { options: Record<string, any> };
    expect(construct.options.tlsOptions).toMatchObject({ rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'ldap.example.com', ca });

    fakeLdap.calls = [];
    fakeLdap.entries.push(person('xavier'));
    const startTls = await addDirectory({ url: 'ldap://ldap.example.com:389', startTls: true });
    expect((await signIn(browser(), startTls, 'xavier', 'xavier-password')).status).toBe(200);
    const constructs = fakeLdap.calls.filter((call) => call.op === 'construct') as Array<{ options: Record<string, any> }>;
    for (const call of constructs) expect(call.options.tlsOptions).toBeUndefined();
    const ops = fakeLdap.calls.map((call) => call.op);
    expect(ops.indexOf('startTLS')).toBeLessThan(ops.indexOf('bind'));
    const upgrade = fakeLdap.calls.find((call) => call.op === 'startTLS') as { options: Record<string, any> };
    expect(upgrade.options).toMatchObject({ rejectUnauthorized: true, servername: 'ldap.example.com', host: 'ldap.example.com' });
  });

  it('never binds over an unencrypted connection unless the directory allows it', async () => {
    // Stored without the validation that would refuse it.
    const id = await addDirectory({ url: 'ldap://ldap.example.com:389', startTls: false, allowUnencrypted: false });
    fakeLdap.entries.push(person('yuri'));
    expect((await signIn(browser(), id, 'yuri', 'yuri-password')).status).toBe(503);
    expect(fakeLdap.binds()).toEqual([]);

    const allowed = await addDirectory({ url: 'ldap://ldap.example.com:389', startTls: false, allowUnencrypted: true });
    expect((await signIn(browser(), allowed, 'yuri', 'yuri-password')).status).toBe(200);
  });
});

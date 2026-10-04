/**
 * LDAP / Active Directory sign-in (ee/ldap), the parts without a server:
 * RFC 4515 escaping and filter templates, DN comparison, the group-to-role
 * mapping, stable unique ids, the transport rules of a connection, the
 * login limiter and the validation of a directory's settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { escapeFilterValue, fillFilter, filterTemplateProblem, isAttributeName, normalizeDn } from '@/ee/ldap/filter';
import { resolveDirectoryRole } from '@/ee/ldap/roles';
import { formatObjectGuid, parseObjectGuid, readUniqueId, signInInputProblem, uniqueIdFilter } from '@/ee/ldap/authenticate';
import { ldapAccountIssuer, ldapProviderId, parseLdapProviderId } from '@/ee/ldap/constants';
import { isDisableOnlyUpdate, parseDirectoryCreate, parseDirectoryUpdate, parseDirectoryUrl } from '@/ee/ldap/directories';
import { DirectoryConnection, tlsOptionsFor } from '@/ee/ldap/connection';
import { fakeLdap } from '../helpers/fake-ldap';

vi.mock('ldapts', async (importOriginal) => {
  const { fakeLdapModule } = await import('../helpers/fake-ldap');
  return fakeLdapModule(await importOriginal<typeof import('ldapts')>());
});

describe('RFC 4515 escaping', () => {
  it('escapes the filter syntax characters, NUL and control characters, and keeps UTF-8', () => {
    expect(escapeFilterValue('Parens (R Us)')).toBe('Parens \\28R Us\\29');
    expect(escapeFilterValue('star*')).toBe('star\\2a');
    expect(escapeFilterValue('C:\\MyFile')).toBe('C:\\5cMyFile');
    expect(escapeFilterValue('nul\0byte')).toBe('nul\\00byte');
    expect(escapeFilterValue('line\nbreak')).toBe('line\\0abreak');
    expect(escapeFilterValue('Lučić')).toBe('Lučić');
    expect(escapeFilterValue('a=b&c|!d')).toBe('a=b&c|!d');
  });

  it('fills every placeholder with an escaped value, so input never changes the filter structure', () => {
    const template = '(&(objectClass=user)(sAMAccountName={username}))';
    expect(fillFilter(template, { username: 'jdoe' })).toBe('(&(objectClass=user)(sAMAccountName=jdoe))');
    expect(fillFilter(template, { username: '*)(objectClass=*' })).toBe('(&(objectClass=user)(sAMAccountName=\\2a\\29\\28objectClass=\\2a))');
    expect(fillFilter('(member={dn})', { dn: 'cn=Smith\\, John,dc=example,dc=com' })).toBe('(member=cn=Smith\\5c, John,dc=example,dc=com)');
    // A replacement pattern in the value is a literal.
    expect(fillFilter('(uid={username})', { username: '$&$1' })).toBe('(uid=$&$1)');
    expect(() => fillFilter('(member={dn})', { username: 'x' })).toThrow();
  });

  it('accepts placeholders only where an assertion value goes', () => {
    const user = (template: string) => filterTemplateProblem(template, ['username'], ['username']);
    expect(user('(uid={username})')).toBeNull();
    expect(user('(&(objectClass=user)(sAMAccountName={username})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))')).toBeNull();
    expect(user('(|(uid={username})(mail={username}))')).toBeNull();
    expect(user('({username}=x)')).toMatch(/as a value/);
    expect(user('(uid=x)({username})')).toMatch(/as a value/);
    expect(user('(uid=x)')).toMatch(/must contain \{username\}/);
    expect(user('(uid={dn})')).toMatch(/not \{dn\}/);
    expect(user('uid={username}')).toMatch(/parentheses/);
    expect(user('(uid={username}')).toMatch(/not a valid/);
    expect(user('')).toMatch(/required/);
    const groupFilter = (template: string) => filterTemplateProblem(template, ['dn', 'username'], ['dn', 'username']);
    expect(groupFilter('(&(objectClass=groupOfNames)(member={dn}))')).toBeNull();
    expect(groupFilter('(&(objectClass=posixGroup)(memberUid={username}))')).toBeNull();
    expect(groupFilter('(objectClass=groupOfNames)')).toMatch(/must contain/);
  });

  it('checks attribute names', () => {
    for (const name of ['uid', 'sAMAccountName', 'entryUUID', 'objectGUID', 'x-custom', '2.5.4.3']) expect(isAttributeName(name), name).toBe(true);
    for (const name of ['', 'a b', 'uid)', '(uid', 'uid=x', '-uid', 'a'.repeat(65)]) expect(isAttributeName(name), name).toBe(false);
  });
});

describe('DN comparison and the group-to-role mapping', () => {
  it('compares DNs without case and without the spaces around separators, keeping escapes', () => {
    expect(normalizeDn('CN=Admins, OU=Groups, DC=example,DC=com')).toBe('cn=admins,ou=groups,dc=example,dc=com');
    expect(normalizeDn(' cn = Admins ,ou=Groups ')).toBe('cn=admins,ou=groups');
    expect(normalizeDn('cn=Smith\\, John,dc=x')).toBe('cn=smith\\, john,dc=x');
    expect(normalizeDn('cn=a\\,b,dc=x')).not.toBe(normalizeDn('cn=a\\, b,dc=x'));
    expect(normalizeDn('cn=trailing\\ ,dc=x')).toBe('cn=trailing\\ ,dc=x');
  });

  const config = {
    groupRoleMappings: [
      { group: 'cn=Admins,ou=groups,dc=example,dc=com', role: 'admin' as const },
      { group: 'cn=Staff,ou=groups,dc=example,dc=com', role: 'user' as const },
      { group: 'cn=Readers,ou=groups,dc=example,dc=com', role: 'viewer' as const },
    ],
    defaultRole: 'viewer' as const,
    requiredGroup: null,
  };

  it('gives the highest mapped role, the default role otherwise, and never reads anything but groups', () => {
    expect(resolveDirectoryRole(config, ['CN=readers,OU=Groups,DC=example,DC=com', 'cn=admins, ou=groups, dc=example, dc=com']))
      .toMatchObject({ role: 'admin', managesRoles: true, inRequiredGroup: true });
    expect(resolveDirectoryRole(config, ['cn=Staff,ou=groups,dc=example,dc=com']).role).toBe('user');
    expect(resolveDirectoryRole(config, ['cn=Other,ou=groups,dc=example,dc=com']).role).toBe('viewer');
    expect(resolveDirectoryRole(config, null)).toMatchObject({ role: 'viewer', matchedGroups: [] });
    // A group that only looks like a mapped one does not match.
    expect(resolveDirectoryRole(config, ['cn=Admins,ou=groups,dc=example,dc=org']).role).toBe('viewer');
    expect(resolveDirectoryRole({ ...config, groupRoleMappings: [] }, ['cn=Admins,ou=groups,dc=example,dc=com']))
      .toMatchObject({ managesRoles: false, role: 'viewer' });
  });

  it('checks the required group', () => {
    const required = { ...config, requiredGroup: 'cn=Ingressi,ou=groups,dc=example,dc=com' };
    expect(resolveDirectoryRole(required, ['cn=admins,ou=groups,dc=example,dc=com']).inRequiredGroup).toBe(false);
    expect(resolveDirectoryRole(required, ['CN=ingressi,OU=groups,DC=example,DC=com']).inRequiredGroup).toBe(true);
    expect(resolveDirectoryRole(required, null).inRequiredGroup).toBe(false);
  });
});

describe('stable unique ids and provider ids', () => {
  const guidBytes = Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'hex');

  it('reads an objectGUID in its GUID form and finds the entry by its bytes again', () => {
    const guid = formatObjectGuid(guidBytes);
    expect(guid).toBe('d4c3b2a1-f6e5-1807-293a-4b5c6d7e8f90');
    expect(parseObjectGuid(guid)?.equals(guidBytes)).toBe(true);
    expect(readUniqueId({ dn: 'cn=x', objectGUID: guidBytes }, 'objectGUID')).toBe(guid);
    const filter = uniqueIdFilter('objectGUID', guid)!;
    expect(Buffer.isBuffer(filter.value) && filter.value.equals(guidBytes)).toBe(true);
    expect(uniqueIdFilter('objectGUID', 'not-a-guid')).toBeNull();
  });

  it('reads text ids as returned, binary ones as hex, and refuses missing or several values', () => {
    expect(readUniqueId({ dn: 'cn=x', entryUUID: Buffer.from('6f1d2a3b-0c4e-4b5a-9d8e-7f6a5b4c3d2e') }, 'entryuuid'))
      .toBe('6f1d2a3b-0c4e-4b5a-9d8e-7f6a5b4c3d2e');
    expect(readUniqueId({ dn: 'cn=x', nsUniqueId: Buffer.from([0xff, 0x00, 0x10]) }, 'nsUniqueId')).toBe('hex:ff0010');
    expect(uniqueIdFilter('nsUniqueId', 'hex:ff0010')?.value).toEqual(Buffer.from([0xff, 0x00, 0x10]));
    expect(readUniqueId({ dn: 'cn=x' }, 'entryUUID')).toBeNull();
    expect(readUniqueId({ dn: 'cn=x', entryUUID: [Buffer.from('a'), Buffer.from('b')] }, 'entryUUID')).toBeNull();
    expect(readUniqueId({ dn: 'cn=x', objectGUID: Buffer.from('short') }, 'objectGUID')).toBeNull();
  });

  it('namespaces directory accounts apart from OAuth providers and local accounts', () => {
    expect(ldapProviderId(7)).toBe('ldap:7');
    expect(parseLdapProviderId('ldap:7')).toBe(7);
    // An OAuth provider configured through the environment gets a slug id such as "ldap-7": never a directory.
    for (const other of ['ldap-7', 'credential', 'ldap:', 'ldap:07', 'ldap:7x', 'LDAP:7']) expect(parseLdapProviderId(other), other).toBeNull();
    expect(ldapAccountIssuer(7)).toBe('local:ldap:7');
  });

  it('refuses empty, blank and oversized credentials before anything is sent', () => {
    expect(signInInputProblem('alice', '')).toMatch(/empty/);
    expect(signInInputProblem('alice', '   ')).toMatch(/empty/);
    expect(signInInputProblem('  ', 'password')).toMatch(/empty/);
    expect(signInInputProblem('alice', 'x'.repeat(1025))).toMatch(/too long/);
    expect(signInInputProblem('ali\0ce', 'password')).toMatch(/control/);
    expect(signInInputProblem('alice', 'pass\0word')).toMatch(/NUL/);
    expect(signInInputProblem(undefined, 'password')).toMatch(/required/);
    expect(signInInputProblem('alice', 'correct horse')).toBeNull();
  });
});

describe('transport rules', () => {
  beforeEach(() => fakeLdap.reset());

  const base = { connectTimeoutMs: 5000, operationTimeoutMs: 10000, caCertificate: null };

  it('verifies certificates and names, with TLS 1.2 at least', () => {
    expect(tlsOptionsFor('ldap.example.com', null)).toEqual({
      host: 'ldap.example.com', servername: 'ldap.example.com', rejectUnauthorized: true, minVersion: 'TLSv1.2',
    });
    // No SNI for an address; the certificate is still checked against it.
    expect(tlsOptionsFor('192.0.2.10', 'PEM')).toEqual({ host: '192.0.2.10', ca: 'PEM', rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  });

  it('refuses ldap:// without StartTLS unless unencrypted connections are allowed, before connecting', async () => {
    await expect(DirectoryConnection.open({ ...base, url: 'ldap://ldap.example.com', startTls: false, allowUnencrypted: false }))
      .rejects.toThrow(/Unencrypted connections are not allowed/);
    await expect(DirectoryConnection.open({ ...base, url: 'ldaps://ldap.example.com', startTls: true, allowUnencrypted: false }))
      .rejects.toThrow(/only used with ldap/);
    expect(fakeLdap.calls).toEqual([]);
  });

  it('upgrades with StartTLS right after connecting, and gives ldaps:// its TLS options', async () => {
    const upgraded = await DirectoryConnection.open({ ...base, url: 'ldap://ldap.example.com:389', startTls: true, allowUnencrypted: false });
    expect(fakeLdap.calls.map((call) => call.op)).toEqual(['construct', 'startTLS']);
    expect((fakeLdap.calls[0] as { options: Record<string, unknown> }).options.tlsOptions).toBeUndefined();
    await upgraded.close();
    fakeLdap.reset();
    await DirectoryConnection.open({ ...base, url: 'ldaps://ldap.example.com', startTls: false, allowUnencrypted: false });
    expect((fakeLdap.calls[0] as { options: Record<string, any> }).options.tlsOptions).toMatchObject({ rejectUnauthorized: true });
  });

  it('never sends an empty password, a missing DN, or a password without TLS', async () => {
    const connection = await DirectoryConnection.open({ ...base, url: 'ldaps://ldap.example.com', startTls: false, allowUnencrypted: false });
    await expect(connection.bind('cn=x,dc=example,dc=com', '')).rejects.toThrow(/empty password/);
    await expect(connection.bind('cn=x,dc=example,dc=com', '  ')).rejects.toThrow(/empty password/);
    await expect(connection.bind('', 'password')).rejects.toThrow(/without a DN/);
    expect(fakeLdap.binds()).toEqual([]);
  });

  it('refuses to open a second socket (a silent reconnect would skip StartTLS)', async () => {
    await DirectoryConnection.open({ ...base, url: 'ldap://ldap.example.com', startTls: true, allowUnencrypted: false });
    const options = (fakeLdap.calls[0] as { options: Record<string, any> }).options;
    // The first socket is created; a reconnect asks again and is refused.
    const first = options.createConnection(389, '127.0.0.1');
    first.on('error', () => {});
    first.destroy();
    expect(() => options.createConnection(389, '127.0.0.1')).toThrow(/not re-opened/);
  });
});

describe('login limiter', () => {
  afterEach(() => vi.resetModules());

  it('blocks an account after the configured failures and admits concurrent attempts no more often', async () => {
    vi.resetModules();
    const { beginDirectoryAttempt, signInAccountKey } = await import('@/ee/ldap/limiter');
    const key = signInAccountKey(1, 'Mallory');
    expect(signInAccountKey(1, ' mallory ')).toBe(key);
    const held = await Promise.all([1, 2, 3, 4, 5].map(() => beginDirectoryAttempt(key, '203.0.113.7')));
    expect(held.every(Boolean)).toBe(true);
    expect(await beginDirectoryAttempt(key, '203.0.113.7')).toBeNull();
    for (const attempt of held) await attempt!.fail();
    expect(await beginDirectoryAttempt(key, '203.0.113.7')).toBeNull();
    // Another username from the same client is blocked too (per-client limit).
    expect(await beginDirectoryAttempt(signInAccountKey(1, 'other'), '203.0.113.7')).toBeNull();
    expect(await beginDirectoryAttempt(signInAccountKey(1, 'other'), '198.51.100.1')).not.toBeNull();
  });
});

describe('directory settings', () => {
  const valid = {
    name: 'Corp',
    url: 'ldaps://ldap.example.com:636',
    bindDn: 'cn=ingressi,ou=services,dc=example,dc=com',
    bindPassword: 'service-secret',
    userSearchBase: 'ou=people,dc=example,dc=com',
    userSearchFilter: '(uid={username})',
  };

  it('accepts a minimal ldaps:// directory with safe defaults', () => {
    expect(parseDirectoryCreate(valid)).toMatchObject({
      enabled: true, startTls: false, allowUnencrypted: false, caCertificate: null,
      groupMode: 'none', groupRoleMappings: [], defaultRole: 'user',
      provisionUsers: false, linkExistingAccounts: false, allowWhenSsoEnforced: false,
      uniqueIdAttribute: 'entryUUID',
    });
  });

  it('turns StartTLS on for ldap:// and refuses plaintext unless explicitly allowed', () => {
    expect(parseDirectoryCreate({ ...valid, url: 'ldap://ldap.example.com' }).startTls).toBe(true);
    expect(() => parseDirectoryCreate({ ...valid, url: 'ldap://ldap.example.com', startTls: false })).toThrow(/needs StartTLS/);
    expect(parseDirectoryCreate({ ...valid, url: 'ldap://ldap.example.com', startTls: false, allowUnencrypted: true }))
      .toMatchObject({ startTls: false, allowUnencrypted: true });
    expect(() => parseDirectoryCreate({ ...valid, allowUnencrypted: true })).toThrow(/only used with ldap/);
    expect(parseDirectoryCreate({ ...valid, allowUnencrypted: false }).allowUnencrypted).toBe(false);
    expect(() => parseDirectoryCreate({ ...valid, startTls: true })).toThrow(/only used with ldap/);
  });

  it('refuses URLs with anything but a scheme, host and port', () => {
    expect(parseDirectoryUrl('ldaps://ldap.example.com:636/')).toBe('ldaps://ldap.example.com:636');
    for (const url of ['https://ldap.example.com', 'ldaps://user:pw@ldap.example.com', 'ldaps://ldap.example.com/dc=example', 'ldaps://ldap.example.com?x', 'not a url']) {
      expect(() => parseDirectoryUrl(url), url).toThrow();
    }
  });

  it('checks the CA certificate and never takes a private key', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() => parseDirectoryCreate({ ...valid, caCertificate: privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toThrow(/private key/);
    expect(() => parseDirectoryCreate({ ...valid, caCertificate: '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----' })).toThrow(/cannot be read/);
    expect(() => parseDirectoryCreate({ ...valid, caCertificate: 'garbage' })).toThrow(/PEM/);
    expect(parseDirectoryCreate({ ...valid, caCertificate: '' }).caCertificate).toBeNull();
  });

  it('grants roles only through explicit group mappings, never admin by default', () => {
    expect(() => parseDirectoryCreate({ ...valid, defaultRole: 'admin' })).toThrow(/defaultRole/);
    expect(() => parseDirectoryCreate({ ...valid, groupRoleMappings: [{ group: 'cn=a,dc=x', role: 'admin' }] })).toThrow(/need a group lookup/);
    const groups = { groupMode: 'member_of' };
    expect(() => parseDirectoryCreate({ ...valid, ...groups, groupRoleMappings: [{ group: 'cn=a,dc=x', role: 'owner' }] })).toThrow(/role must be/);
    expect(() => parseDirectoryCreate({ ...valid, ...groups, groupRoleMappings: [{ group: 'cn=A,dc=x', role: 'admin' }, { group: 'CN=a, DC=x', role: 'user' }] }))
      .toThrow(/twice/);
    expect(() => parseDirectoryCreate({ ...valid, requiredGroup: 'cn=a,dc=x' })).toThrow(/needs a group lookup/);
    expect(() => parseDirectoryCreate({ ...valid, ...groups, nestedGroups: true })).toThrow(/groupSearchBase/);
    expect(() => parseDirectoryCreate({ ...valid, groupMode: 'search', groupSearchBase: 'ou=g,dc=x' })).toThrow(/groupSearchFilter/);
    expect(parseDirectoryCreate({
      ...valid, groupMode: 'search', groupSearchBase: 'ou=g,dc=x', groupSearchFilter: '(member={dn})',
      groupRoleMappings: [{ group: 'cn=admins,ou=g,dc=x', role: 'admin' }], requiredGroup: 'cn=users,ou=g,dc=x',
    })).toMatchObject({ groupRoleMappings: [{ group: 'cn=admins,ou=g,dc=x', role: 'admin' }], requiredGroup: 'cn=users,ou=g,dc=x' });
  });

  it('refuses unknown fields, a filter without {username} and a missing password', () => {
    expect(() => parseDirectoryCreate({ ...valid, role: 'admin' })).toThrow(/Unknown field "role"/);
    expect(() => parseDirectoryCreate({ ...valid, userSearchFilter: '(uid=alice)' })).toThrow(/\{username\}/);
    const { bindPassword: _omit, ...withoutPassword } = valid;
    void _omit;
    expect(() => parseDirectoryCreate(withoutPassword)).toThrow(/bindPassword is required/);
    expect(() => parseDirectoryCreate({ ...valid, bindPassword: '   ' })).toThrow(/blank/);
  });

  function storedRow(overrides: Record<string, unknown> = {}) {
    const parsed = parseDirectoryCreate(valid);
    return {
      id: 3, ...parsed, bindPassword: 'enc:v1:stored', groupRoleMappings: '[]', createdBy: 1,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...overrides,
    } as never;
  }

  it('asks for the service account password again when the URL changes', () => {
    expect(() => parseDirectoryUpdate({ url: 'ldaps://evil.example.org' }, storedRow())).toThrow(/password again/);
    expect(parseDirectoryUpdate({ url: 'ldaps://other.example.com', bindPassword: 'new' }, storedRow()).url).toBe('ldaps://other.example.com');
    expect(parseDirectoryUpdate({ name: 'Renamed' }, storedRow()).bindPassword).toBeUndefined();
  });

  it('recognizes an update that only disables the directory', () => {
    expect(isDisableOnlyUpdate({ enabled: false }, storedRow())).toBe(true);
    expect(isDisableOnlyUpdate({ enabled: false, name: 'Corp', bindPassword: '' }, storedRow())).toBe(true);
    expect(isDisableOnlyUpdate({ enabled: false, name: 'Other' }, storedRow())).toBe(false);
    expect(isDisableOnlyUpdate({ enabled: false, bindPassword: 'x' }, storedRow())).toBe(false);
    expect(isDisableOnlyUpdate({ enabled: false, allowWhenSsoEnforced: true }, storedRow())).toBe(false);
    expect(isDisableOnlyUpdate({ enabled: true }, storedRow())).toBe(false);
  });
});

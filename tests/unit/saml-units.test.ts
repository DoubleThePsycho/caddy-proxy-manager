/**
 * The pieces of SAML sign-in (ee/saml) that need no identity provider:
 * sign-ins in progress and the replay table, the account id and attributes
 * read from an assertion, the group-to-role decision, IdP metadata, the
 * return path and the ACS body limit, and the namespaces of SAML accounts.
 */
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { createTestKey, idpMetadataXml, IDP_ENTITY_ID, IDP_SSO_URL, PERSISTENT, EMAIL_FORMAT } from '../helpers/saml-idp';
import { consumePendingRequest, createPendingRequest, hashBindingSecret, newRequestId, recordAssertionUse } from '@/ee/saml/requests';
import { readSamlUser } from '@/ee/saml/sign-in';
import { resolveSamlRole } from '@/ee/saml/roles';
import { parseIdpMetadata } from '@/ee/saml/metadata';
import { readFormBody, safeCallbackPath } from '@/ee/saml/plugin';
import { LIMITS, REQUEST_TTL_MS, parseSamlProviderId, samlAccountIssuer, samlProviderId } from '@/ee/saml/constants';
import { parseLdapProviderId } from '@/ee/ldap/constants';
import { CREDENTIAL_ACCOUNT_ISSUER, resolveOAuthAccountIssuer } from '@/src/lib/account-issuer';

describe('sign-ins in progress', () => {
  it('stores only the hash of the binding secret and hands each sign-in out once', async () => {
    const db = createTestDb();
    const requestId = newRequestId();
    expect(requestId).toMatch(/^_[0-9a-f]{40}$/);
    const secret = await createPendingRequest(db, { providerId: 3, requestId, callbackUrl: '/' });
    const [row] = await db.select().from(schema.samlRequests);
    expect(row.bindingHash).toBe(hashBindingSecret(secret));
    expect(JSON.stringify(row)).not.toContain(secret);

    expect(await consumePendingRequest(db, 'another-browser')).toBeNull();
    expect(await consumePendingRequest(db, null)).toBeNull();
    expect(await consumePendingRequest(db, secret)).toMatchObject({ providerId: 3, requestId, callbackUrl: '/' });
    expect(await consumePendingRequest(db, secret)).toBeNull();
  });

  it('expires sign-ins after REQUEST_TTL_MS and drops expired ones', async () => {
    const db = createTestDb();
    const start = Date.now();
    const secret = await createPendingRequest(db, { providerId: 1, requestId: newRequestId(), callbackUrl: '/' }, start);
    expect(await consumePendingRequest(db, secret, start + REQUEST_TTL_MS + 1)).toBeNull();
    await createPendingRequest(db, { providerId: 1, requestId: newRequestId(), callbackUrl: '/' }, start);
    await createPendingRequest(db, { providerId: 1, requestId: newRequestId(), callbackUrl: '/' }, start + REQUEST_TTL_MS + 1);
    expect(await db.select().from(schema.samlRequests)).toHaveLength(1);
  });

  it('bounds how many sign-ins unauthenticated clients can leave open', async () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 60_000).toISOString();
    for (let index = 0; index < LIMITS.pendingRequests; index += 1) {
      await db.insert(schema.samlRequests).values({ providerId: 1, requestId: `_old${index}`, bindingHash: `h${index}`, callbackUrl: '/', createdAt: now, expiresAt: later });
    }
    await createPendingRequest(db, { providerId: 1, requestId: '_newest', callbackUrl: '/' });
    const rows = await db.select({ requestId: schema.samlRequests.requestId }).from(schema.samlRequests);
    expect(rows).toHaveLength(LIMITS.pendingRequests);
    expect(rows.map((row) => row.requestId)).toContain('_newest');
    expect(rows.map((row) => row.requestId)).not.toContain('_old0');
  });
});

describe('replay records', () => {
  it('accepts an assertion ID once per provider until it expires', async () => {
    const db = createTestDb();
    const now = Date.now();
    expect(await recordAssertionUse(db, { providerId: 1, assertionId: '_a', until: now + 60_000 }, now)).toBe(true);
    expect(await recordAssertionUse(db, { providerId: 1, assertionId: '_a', until: now + 60_000 }, now + 1000)).toBe(false);
    expect(await recordAssertionUse(db, { providerId: 2, assertionId: '_a', until: now + 60_000 }, now)).toBe(true);
    // Once it could no longer be accepted, the record goes (the time checks refuse the assertion then).
    expect(await recordAssertionUse(db, { providerId: 1, assertionId: '_b', until: now + 60_000 }, now + 120_000)).toBe(true);
    expect((await db.select().from(schema.samlUsedAssertions)).map((row) => row.assertionId).sort()).toEqual(['_b']);
  });
});

describe('the user an assertion describes', () => {
  const config = { subjectAttribute: null, emailAttribute: 'mail', nameAttribute: 'displayName', groupsAttribute: 'memberOf' };

  it('uses a persistent NameID as the account id, and reads the configured attributes exactly', () => {
    const user = readSamlUser(config, {
      nameId: 'G-3f1c', nameIdFormat: PERSISTENT,
      attributes: new Map([['mail', ['Alice@Example.com']], ['displayName', ['Alice L.']], ['memberOf', ['a', ' b ', 'a']], ['role', ['admin']]]),
    });
    expect(user).toMatchObject({ subject: 'G-3f1c', email: 'Alice@Example.com', displayName: 'Alice L.', groups: ['a', 'b'] });
  });

  it('never uses a NameID that is not persistent, nor the e-mail, unless an attribute is configured', () => {
    expect(readSamlUser(config, { nameId: 'alice@example.com', nameIdFormat: EMAIL_FORMAT, attributes: new Map([['mail', ['alice@example.com']]]) })).toBeNull();
    expect(readSamlUser(config, { nameId: 'x', nameIdFormat: null, attributes: new Map() })).toBeNull();
    const byMail = readSamlUser({ ...config, subjectAttribute: 'mail' }, { nameId: null, nameIdFormat: null, attributes: new Map([['mail', ['alice@example.com']]]) });
    expect(byMail?.subject).toBe('alice@example.com');
    expect(readSamlUser({ ...config, subjectAttribute: 'oid' }, { nameId: 'x', nameIdFormat: PERSISTENT, attributes: new Map([['oid', ['1', '2']]]) })).toBeNull();
    expect(readSamlUser({ ...config, subjectAttribute: 'oid' }, { nameId: 'x', nameIdFormat: PERSISTENT, attributes: new Map([['oid', ['bad\nid']]]) })).toBeNull();
  });

  it('ignores an e-mail value that is not an address', () => {
    const user = readSamlUser(config, { nameId: 's', nameIdFormat: PERSISTENT, attributes: new Map([['mail', ['not an address']]]) });
    expect(user?.email).toBeNull();
  });
});

describe('group-to-role decision', () => {
  const mappings = [{ group: 'admins', role: 'admin' as const }, { group: 'readers', role: 'viewer' as const }];

  it('gives the highest mapped role, or the default, and compares groups exactly', () => {
    expect(resolveSamlRole({ groupRoleMappings: mappings, defaultRole: 'user', requiredGroup: null }, ['readers', 'admins']))
      .toMatchObject({ role: 'admin', managesRoles: true, inRequiredGroup: true, matchedGroups: ['admins', 'readers'] });
    expect(resolveSamlRole({ groupRoleMappings: mappings, defaultRole: 'viewer', requiredGroup: null }, ['Admins'])).toMatchObject({ role: 'viewer' });
    expect(resolveSamlRole({ groupRoleMappings: [], defaultRole: 'user', requiredGroup: 'staff' }, ['other']))
      .toMatchObject({ managesRoles: false, inRequiredGroup: false });
  });
});

describe('IdP metadata', () => {
  it('reads the entity ID, the HTTP-Redirect URL and every signing certificate', () => {
    const one = createTestKey('one.example.com');
    const two = createTestKey('two.example.com');
    const parsed = parseIdpMetadata(idpMetadataXml([one.certificate, two.certificate]));
    expect(parsed).toMatchObject({ entityId: IDP_ENTITY_ID, ssoUrl: IDP_SSO_URL });
    expect(parsed.certificates).toHaveLength(2);
  });

  it('refuses a DOCTYPE, a POST-only IdP, missing certificates and other documents', () => {
    const key = createTestKey();
    expect(() => parseIdpMetadata(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${idpMetadataXml([key.certificate])}`)).toThrow(/DOCTYPE/);
    expect(() => parseIdpMetadata(idpMetadataXml([key.certificate], { postOnly: true }))).toThrow(/HTTP-Redirect/);
    expect(() => parseIdpMetadata(idpMetadataXml([]))).toThrow(/certificate/);
    expect(() => parseIdpMetadata('<x/>')).toThrow(/EntityDescriptor/);
    expect(() => parseIdpMetadata('<md:EntityDescriptor')).toThrow(/well-formed/);
  });
});

describe('the ACS request', () => {
  it('returns only to paths on this dashboard', () => {
    expect(safeCallbackPath('/proxy-hosts?x=1')).toBe('/proxy-hosts?x=1');
    for (const value of [undefined, '', 'https://evil.example.org', '//evil.example.org', '/\\evil.example.org', 'proxy-hosts', '/a\nb']) {
      expect(safeCallbackPath(value)).toBe('/');
    }
  });

  it('reads a form body up to the limit, and nothing else', async () => {
    const form = (body: string, type = 'application/x-www-form-urlencoded') =>
      new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': type }, body });
    expect((await readFormBody(form('SAMLResponse=abc&RelayState=1'), 1024))?.get('SAMLResponse')).toBe('abc');
    expect(await readFormBody(form('{"SAMLResponse":"abc"}', 'application/json'), 1024)).toBeNull();
    expect(await readFormBody(form(`SAMLResponse=${'a'.repeat(2048)}`), 1024)).toBeNull();
    expect(await readFormBody(undefined, 1024)).toBeNull();
  });
});

describe('account namespaces', () => {
  it('gives SAML accounts a provider id and issuer of their own', () => {
    expect(samlProviderId(4)).toBe('saml:4');
    expect(parseSamlProviderId('saml:4')).toBe(4);
    for (const other of ['credential', 'ldap:4', 'saml:', 'saml:04', 'saml:4x', 'a1b2c3', undefined]) {
      expect(parseSamlProviderId(other)).toBeNull();
    }
    expect(parseLdapProviderId('saml:4')).toBeNull();
    const issuers = new Set([samlAccountIssuer(4), 'local:ldap:4', CREDENTIAL_ACCOUNT_ISSUER, resolveOAuthAccountIssuer('saml:4'), resolveOAuthAccountIssuer('4')]);
    expect(issuers.size).toBe(5);
    expect(samlAccountIssuer(4)).toBe('local:saml:4');
  });
});

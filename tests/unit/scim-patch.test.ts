/**
 * SCIM filters, PATCH paths and the User attribute changes they make, with
 * the request shapes Microsoft Entra ID and Okta send (operation names in any
 * case, path-less value objects, "True"/"False" strings, emails[type eq
 * "work"].value). Identifiers are taken exactly as sent; roles and passwords
 * are ignored.
 */
import { describe, expect, it } from 'vitest';
import { parseComparison, parseListFilter, parsePath } from '@/ee/scim/filter';
import { readPatchOperations, readScimBoolean } from '@/ee/scim/patch';
import { ScimError } from '@/ee/scim/protocol';
import { accountEmailOf, accountNameOf, applyUserPatch, readUserResource, type UserAttributes } from '@/ee/scim/user-attributes';

const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

function base(): UserAttributes {
  return {
    userName: 'Alice@Example.com',
    externalId: 'ext-1',
    displayName: 'Alice',
    givenName: 'Alice',
    familyName: 'Doe',
    formattedName: null,
    emails: [{ value: 'Alice@Example.com', type: 'work', primary: true }],
    active: true,
  };
}

function patch(current: UserAttributes, ...operations: unknown[]): UserAttributes {
  return applyUserPatch(current, readPatchOperations({ schemas: [PATCH], Operations: operations }));
}

function scimError(fn: () => unknown): ScimError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ScimError);
    return error as ScimError;
  }
  throw new Error('expected a ScimError');
}

describe('filters', () => {
  it('parses eq comparisons, case-insensitive attribute names and the core schema prefix', () => {
    expect(parseComparison('userName eq "alice@example.com"')).toEqual({ attribute: 'username', value: 'alice@example.com' });
    expect(parseComparison('externalId EQ "0a1b"')).toEqual({ attribute: 'externalid', value: '0a1b' });
    expect(parseComparison('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "x"')).toEqual({ attribute: 'username', value: 'x' });
    expect(parseComparison('displayName eq "Quote \\" inside"')).toEqual({ attribute: 'displayname', value: 'Quote " inside' });
  });

  it('refuses other operators and combined filters', () => {
    expect(scimError(() => parseComparison('userName co "a"')).scimType).toBe('invalidFilter');
    expect(scimError(() => parseComparison('userName eq "a" and externalId eq "b"')).scimType).toBe('invalidFilter');
    expect(scimError(() => parseComparison('userName eq')).status).toBe(400);
  });

  it('limits list filters to the supported attributes', () => {
    expect(parseListFilter(null, ['username'])).toBeNull();
    expect(parseListFilter('userName eq "a"', ['username', 'externalid'])).toEqual({ attribute: 'username', value: 'a' });
    expect(scimError(() => parseListFilter('title eq "a"', ['username'])).scimType).toBe('invalidFilter');
  });
});

describe('PATCH paths', () => {
  it('parses attributes, sub-attributes and value filters', () => {
    expect(parsePath('active')).toEqual({ attribute: 'active', filter: null, subAttribute: null });
    expect(parsePath('name.givenName')).toEqual({ attribute: 'name', filter: null, subAttribute: 'givenname' });
    expect(parsePath('emails[type eq "work"].value')).toEqual({
      attribute: 'emails', filter: { attribute: 'type', value: 'work' }, subAttribute: 'value',
    });
    expect(parsePath('members[value eq "42"]')).toEqual({ attribute: 'members', filter: { attribute: 'value', value: '42' }, subAttribute: null });
  });

  it('keeps extension attributes whole so they can be ignored', () => {
    const path = parsePath('urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department');
    expect(path.attribute.startsWith('urn:')).toBe(true);
  });

  it('validates operations', () => {
    expect(scimError(() => readPatchOperations({ Operations: [] })).scimType).toBe('invalidSyntax');
    expect(scimError(() => readPatchOperations({ Operations: [{ op: 'move', path: 'active', value: true }] })).scimType).toBe('invalidSyntax');
    expect(scimError(() => readPatchOperations({ Operations: [{ op: 'remove' }] })).scimType).toBe('noTarget');
    expect(scimError(() => readPatchOperations({ schemas: ['urn:other'], Operations: [{ op: 'add', path: 'active', value: true }] })).status).toBe(400);
    expect(readPatchOperations({ Operations: [{ op: 'Replace', path: 'active', value: 'False' }] })[0].op).toBe('replace');
  });
});

describe('booleans', () => {
  it('accepts booleans and the strings Entra ID sends', () => {
    expect(readScimBoolean(false, 'active')).toBe(false);
    expect(readScimBoolean('False', 'active')).toBe(false);
    expect(readScimBoolean('TRUE', 'active')).toBe(true);
    expect(() => readScimBoolean('no', 'active')).toThrow(/true or false/);
    expect(() => readScimBoolean(0, 'active')).toThrow(/true or false/);
  });
});

describe('User PATCH (Entra ID shapes)', () => {
  it('deactivates with Replace active "False"', () => {
    expect(patch(base(), { op: 'Replace', path: 'active', value: 'False' }).active).toBe(false);
  });

  it('sets the work address through emails[type eq "work"].value', () => {
    const next = patch(base(), { op: 'Add', path: 'emails[type eq "work"].value', value: 'alice.new@example.com' });
    expect(next.emails).toEqual([{ value: 'alice.new@example.com', type: 'work', primary: true }]);
  });

  it('creates the filtered address when none matches', () => {
    const current = { ...base(), emails: [] };
    const next = patch(current, { op: 'Add', path: 'emails[type eq "work"].value', value: 'w@example.com' });
    expect(next.emails).toEqual([{ value: 'w@example.com', type: 'work', primary: true }]);
  });

  it('changes name parts and display name, and removes externalId', () => {
    const next = patch(
      base(),
      { op: 'Replace', path: 'name.givenName', value: 'Alicia' },
      { op: 'Replace', path: 'displayName', value: 'Alicia Doe' },
      { op: 'Remove', path: 'externalId' }
    );
    expect(next).toMatchObject({ givenName: 'Alicia', displayName: 'Alicia Doe', externalId: null, familyName: 'Doe' });
  });

  it('ignores enterprise extension and other unkept attributes', () => {
    const next = patch(
      base(),
      { op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'Sales' },
      { op: 'Replace', path: 'title', value: 'Engineer' },
      { op: 'Replace', path: 'phoneNumbers[type eq "work"].value', value: '+1 555 0100' }
    );
    expect(next).toEqual(base());
  });

  it('never takes a role or a password', () => {
    const next = patch(
      base(),
      { op: 'Add', path: 'roles', value: [{ value: 'admin', primary: true }] },
      { op: 'Replace', value: { password: 'Secret-Password-1', roles: [{ value: 'admin' }] } }
    );
    expect(next).toEqual(base());
  });

  it('refuses removing userName or active', () => {
    expect(scimError(() => patch(base(), { op: 'Remove', path: 'userName' })).scimType).toBe('mutability');
    expect(scimError(() => patch(base(), { op: 'Remove', path: 'active' })).scimType).toBe('mutability');
  });
});

describe('User PATCH (Okta shapes)', () => {
  it('deactivates with a path-less replace', () => {
    expect(patch(base(), { op: 'replace', value: { active: false } }).active).toBe(false);
  });

  it('applies path-less objects attribute by attribute, dotted keys included', () => {
    const next = patch(base(), {
      op: 'replace',
      value: { id: '9', displayName: 'A. Doe', 'name.familyName': 'Smith', name: { givenName: 'Ann' } },
    });
    expect(next).toMatchObject({ displayName: 'A. Doe', givenName: 'Ann', familyName: null });
  });

  it('replaces the whole e-mail list', () => {
    const next = patch(base(), { op: 'replace', path: 'emails', value: [{ value: 'ann@example.com', type: 'work', primary: true }] });
    expect(next.emails).toEqual([{ value: 'ann@example.com', type: 'work', primary: true }]);
  });

  it('keeps one primary address when adding a new primary one', () => {
    const next = patch(base(), { op: 'add', path: 'emails', value: [{ value: 'home@example.com', type: 'home', primary: true }] });
    expect(next.emails.filter((email) => email.primary).map((email) => email.value)).toEqual(['home@example.com']);
  });
});

describe('User resources', () => {
  it('reads an Okta create body exactly as sent', () => {
    const attributes = readUserResource({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'Bob.Smith@Example.com',
      name: { givenName: 'Bob', familyName: 'Smith' },
      emails: [{ primary: true, value: 'Bob.Smith@Example.com', type: 'work' }],
      displayName: 'Bob Smith',
      locale: 'en-US',
      externalId: '00u1abcd',
      groups: [],
      password: 'ignored',
      active: true,
    }, null);
    expect(attributes.userName).toBe('Bob.Smith@Example.com');
    expect(attributes.externalId).toBe('00u1abcd');
    expect(accountEmailOf(attributes)).toBe('bob.smith@example.com');
    expect(accountNameOf(attributes)).toBe('Bob Smith');
  });

  it('keeps the current active flag when a replace leaves it out', () => {
    const attributes = readUserResource({ userName: 'x', emails: [{ value: 'x@example.com' }] }, { ...base(), active: false });
    expect(attributes.active).toBe(false);
  });

  it('chooses the primary address, else the work one, else the first', () => {
    const emails = [
      { value: 'home@example.com', type: 'home', primary: false },
      { value: 'work@example.com', type: 'work', primary: false },
    ];
    expect(accountEmailOf({ ...base(), emails })).toBe('work@example.com');
    expect(accountEmailOf({ ...base(), emails: [emails[0], { ...emails[1], type: 'other' }] })).toBe('home@example.com');
  });

  it('refuses users without an address, portal addresses and non-addresses', () => {
    expect(scimError(() => accountEmailOf({ ...base(), emails: [] })).scimType).toBe('invalidValue');
    expect(scimError(() => readUserResource({ userName: 'root', emails: [{ value: 'root@localhost' }] }, null)).status).toBe(400);
    expect(scimError(() => readUserResource({ userName: 'root', emails: [{ value: 'root' }] }, null)).status).toBe(400);
    expect(scimError(() => readUserResource({ emails: [{ value: 'a@example.com' }] }, null)).status).toBe(400);
  });

  it('refuses an address lowercasing would turn into another one', () => {
    // KELVIN SIGN lowercases to an ASCII "k".
    const attributes = readUserResource({ userName: 'k', emails: [{ value: 'Kate@example.com' }] }, null);
    expect(scimError(() => accountEmailOf(attributes)).status).toBe(400);
  });
});

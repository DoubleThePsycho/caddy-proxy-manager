/**
 * An in-memory directory behind a fake ldapts Client, for the LDAP sign-in
 * tests. Use it in a vi.mock factory:
 *
 *   vi.mock('ldapts', async (importOriginal) => {
 *     const { fakeLdapModule } = await import('../helpers/fake-ldap');
 *     return fakeLdapModule(await importOriginal<typeof import('ldapts')>());
 *   });
 *
 * Every client operation is recorded in `fakeLdap.calls`, so tests can check
 * what reached the server (binds, filters, TLS options). Filters are
 * evaluated with a small matcher for the shapes the tests use: &, |, !,
 * equality, presence and Active Directory's in-chain member rule.
 */
import type * as Ldapts from 'ldapts';

export type FakeEntry = {
  dn: string;
  password?: string;
  attributes: Record<string, string | string[] | Buffer>;
};

export type FakeCall =
  | { op: 'construct'; options: Record<string, unknown> }
  | { op: 'startTLS'; options: Record<string, unknown> }
  | { op: 'bind'; dn: string; password: string }
  | { op: 'search'; base: string; filter: string; options: Record<string, unknown> }
  | { op: 'unbind' };

function createState() {
  return {
  serviceDn: 'cn=ingressi,ou=services,dc=example,dc=com',
  servicePassword: 'service-secret',
  entries: [] as FakeEntry[],
  calls: [] as FakeCall[],
  /** Makes every connection fail, like a server that is down. */
  unreachable: false,
  reset(): void {
    this.entries = [];
    this.calls = [];
    this.unreachable = false;
  },
  binds(): Array<{ dn: string; password: string }> {
    return this.calls
      .filter((call): call is Extract<FakeCall, { op: 'bind' }> => call.op === 'bind')
      .map(({ dn, password }) => ({ dn, password }));
  },
  searches(): Array<Extract<FakeCall, { op: 'search' }>> {
    return this.calls.filter((call): call is Extract<FakeCall, { op: 'search' }> => call.op === 'search');
  },
  };
}

/**
 * The directory's state. Kept on globalThis: a test that resets its modules
 * gets a second instance of this file through the mock factory, and both must
 * see the same directory.
 */
const holder = globalThis as { __FAKE_LDAP__?: ReturnType<typeof createState> };
export const fakeLdap = (holder.__FAKE_LDAP__ ??= createState());

const lower = (value: string) => value.toLowerCase();

function values(entry: FakeEntry, attribute: string): Array<string | Buffer> {
  if (lower(attribute) === 'dn') return [entry.dn];
  const key = Object.keys(entry.attributes).find((name) => lower(name) === lower(attribute));
  if (!key) return [];
  const value = entry.attributes[key];
  return Array.isArray(value) ? value : [value];
}

function equal(a: string | Buffer, b: string | Buffer): boolean {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) {
    return Buffer.from(a as Buffer).equals(Buffer.from(b as Buffer));
  }
  return lower(a) === lower(b);
}

/** Groups (entries with a member attribute) that contain `dn`, directly or through other groups. */
function groupsInChain(dn: string): Set<string> {
  const found = new Set<string>();
  let frontier = [lower(dn)];
  while (frontier.length) {
    const next: string[] = [];
    for (const group of fakeLdap.entries) {
      if (found.has(lower(group.dn))) continue;
      if (values(group, 'member').some((member) => frontier.includes(lower(String(member))))) {
        found.add(lower(group.dn));
        next.push(lower(group.dn));
      }
    }
    frontier = next;
  }
  return found;
}

function matches(actual: typeof Ldapts, filter: Ldapts.Filter, entry: FakeEntry): boolean {
  if (filter instanceof actual.AndFilter) return filter.filters.every((child) => matches(actual, child, entry));
  if (filter instanceof actual.OrFilter) return filter.filters.some((child) => matches(actual, child, entry));
  if (filter instanceof actual.NotFilter) return !matches(actual, filter.filter, entry);
  if (filter instanceof actual.PresenceFilter) return values(entry, filter.attribute).length > 0;
  if (filter instanceof actual.EqualityFilter) {
    return values(entry, filter.attribute).some((value) => equal(value, filter.value));
  }
  if (filter instanceof actual.ExtensibleFilter) {
    if (filter.rule === '1.2.840.113556.1.4.1941' && lower(filter.matchType) === 'member') {
      return groupsInChain(String(filter.value)).has(lower(entry.dn));
    }
    return false;
  }
  throw new Error(`fake-ldap: unsupported filter ${filter.toString()}`);
}

function inScope(entry: FakeEntry, base: string, scope: string | undefined): boolean {
  const dn = lower(entry.dn);
  const b = lower(base);
  if (scope === 'base') return dn === b;
  return dn === b || dn.endsWith(`,${b}`);
}

function toEntry(entry: FakeEntry, attributes: string[] | undefined, buffers: string[] | undefined): Ldapts.Entry {
  const result: Ldapts.Entry = { dn: entry.dn };
  for (const [name, raw] of Object.entries(entry.attributes)) {
    if (attributes && !attributes.some((wanted) => lower(wanted) === lower(name))) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    const asBuffer = buffers?.includes(name);
    const converted = list.map((value) => (asBuffer ? Buffer.from(value as string) : value)) as Array<string | Buffer>;
    result[name] = (converted.length === 1 ? converted[0] : converted) as never;
  }
  return result;
}

export function fakeLdapModule(actual: typeof Ldapts): typeof Ldapts {
  class FakeClient {
    private bound = false;
    constructor(options: Record<string, unknown>) {
      fakeLdap.calls.push({ op: 'construct', options });
    }

    async startTLS(options: Record<string, unknown> = {}): Promise<void> {
      if (fakeLdap.unreachable) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      fakeLdap.calls.push({ op: 'startTLS', options });
    }

    async bind(dn: string, password?: string): Promise<void> {
      if (fakeLdap.unreachable) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      fakeLdap.calls.push({ op: 'bind', dn, password: password ?? '' });
      if (dn === fakeLdap.serviceDn && password === fakeLdap.servicePassword) {
        this.bound = true;
        return;
      }
      const entry = fakeLdap.entries.find((candidate) => lower(candidate.dn) === lower(dn));
      // Like a real server: an entry's own password, nothing else. (An empty
      // password would be an unauthenticated bind; the code under test must
      // never send one.)
      if (entry?.password !== undefined && password === entry.password && password !== '') {
        this.bound = true;
        return;
      }
      throw new actual.InvalidCredentialsError();
    }

    async search(base: string, options: Ldapts.SearchOptions = {}): Promise<Ldapts.SearchResult> {
      if (!this.bound) throw new actual.InsufficientAccessError('not bound');
      const filter = typeof options.filter === 'string'
        ? actual.FilterParser.parseString(options.filter)
        : options.filter ?? new actual.PresenceFilter({ attribute: 'objectClass' });
      fakeLdap.calls.push({
        op: 'search',
        base,
        filter: typeof options.filter === 'string' ? options.filter : filter.toString(),
        options: { ...options },
      });
      let found = fakeLdap.entries.filter((entry) => inScope(entry, base, options.scope) && matches(actual, filter, entry));
      if (options.scope === 'base' && found.length === 0 && !fakeLdap.entries.some((entry) => inScope(entry, base, 'sub'))) {
        throw new actual.NoSuchObjectError('no such object');
      }
      if (options.sizeLimit) found = found.slice(0, options.sizeLimit);
      return {
        searchEntries: found.map((entry) => toEntry(entry, options.attributes, options.explicitBufferAttributes)),
        searchReferences: [],
      };
    }

    async *searchPaginated(base: string, options: Ldapts.SearchOptions = {}): AsyncGenerator<Ldapts.SearchResult> {
      yield await this.search(base, { ...options, paged: undefined });
    }

    async unbind(): Promise<void> {
      fakeLdap.calls.push({ op: 'unbind' });
    }
  }

  return { ...actual, Client: FakeClient as unknown as typeof Ldapts.Client };
}

/** An OpenLDAP-style person entry. */
export function person(uid: string, options: { password?: string; mail?: string | null; cn?: string; uuid?: string; base?: string } = {}): FakeEntry {
  const attributes: FakeEntry['attributes'] = {
    objectClass: ['inetOrgPerson', 'person'],
    uid,
    cn: options.cn ?? `${uid} Example`,
    entryUUID: options.uuid ?? `00000000-0000-4000-8000-${Buffer.from(uid).toString('hex').padEnd(12, '0').slice(0, 12)}`,
  };
  if (options.mail !== null) attributes.mail = options.mail ?? `${uid}@example.com`;
  return { dn: `uid=${uid},${options.base ?? 'ou=people,dc=example,dc=com'}`, password: options.password ?? `${uid}-password`, attributes };
}

/** A groupOfNames entry. */
export function group(cn: string, members: string[]): FakeEntry {
  return {
    dn: `cn=${cn},ou=groups,dc=example,dc=com`,
    attributes: { objectClass: ['groupOfNames'], cn, member: members },
  };
}

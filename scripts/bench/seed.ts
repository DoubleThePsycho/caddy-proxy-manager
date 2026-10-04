/**
 * The benchmark database (scripts/bench/db-hot-paths.ts): a realistic
 * installation written through the synchronous Drizzle instance that opens
 * the database (src/lib/db/sqlite.ts), so the same file seeds both the
 * synchronous and the asynchronous code and the rows are identical.
 *
 * Everything is derived from the loop indexes: two seeds of the same commit
 * produce byte-identical Caddy documents, and the document hash can be
 * compared across commits. Names, domains and addresses are documentation
 * values only (example.com, 192.0.2.0/24, 198.51.100.0/24).
 */
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/src/lib/db/sqlite";
import {
  accessListEntries,
  accessListRules,
  accessLists,
  certificates,
  forwardAuthAccess,
  forwardAuthSessions,
  groupMembers,
  groups,
  l4ProxyHosts,
  monetizationConsumers,
  monetizationHosts,
  monetizationKeys,
  monetizationPlans,
  proxyHosts,
  settings,
  users,
  wafRuleExclusions,
} from "@/src/lib/db/schema";
import { encryptSecret } from "@/src/lib/secret";

export const SEED_SIZE = {
  proxyHosts: 300,
  users: 50,
  groups: 8,
  accessLists: 20,
  managedCertificates: 15,
  l4Hosts: 6,
  forwardAuthSessions: 200,
  monetizationPlans: 3,
  monetizationConsumers: 40,
  monetizedHosts: 5,
} as const;

const CREATED_AT = "2026-09-01T00:00:00.000Z";
const NEVER_EXPIRES = "2099-01-01T00:00:00.000Z";
/** A fixed salt, so the access list hashes (and the Caddy document) are the same on every seed. */
const BCRYPT_SALT = "$2b$10$benchbenchbenchbenchbe";

/** A stable timestamp per row, so ORDER BY createdAt is deterministic. */
function createdAt(index: number): string {
  return new Date(Date.parse(CREATED_AT) + index * 60_000).toISOString();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A deterministic forward-auth session token (64 hex characters). */
export function sessionToken(index: number): string {
  return sha256Hex(`bench-forward-auth-session-${index}`);
}

/** A deterministic, well-formed consumer API key (ik_<12 hex>_<43 base64url>). */
export function consumerKey(index: number): { raw: string; prefix: string; hash: string } {
  const prefix = `ik_${index.toString(16).padStart(12, "0")}`;
  const secret = createHash("sha256").update(`bench-consumer-key-${index}`).digest("base64url");
  const raw = `${prefix}_${secret}`;
  return { raw, prefix, hash: sha256Hex(raw) };
}

/** The hosts each feature is on (1-based host numbers; ids equal them on a fresh database). */
export const hostFeatures = {
  forwardAuth: (n: number) => n % 3 === 0,
  accessList: (n: number) => n % 4 === 1 && n % 3 !== 0,
  waf: (n: number) => n % 5 === 0,
  geoblock: (n: number) => n % 11 === 0,
  rateLimit: (n: number) => n % 13 === 0,
  redirects: (n: number) => n % 17 === 0,
  locationRules: (n: number) => n % 19 === 0,
  disabled: (n: number) => n % 25 === 0,
};

export type SeededIds = {
  adminUserId: number;
  /** The host the forward-auth benchmark verifies against (forward auth on, granted to a group). */
  forwardAuthHostId: number;
  forwardAuthOrigin: string;
  /** A user with access to forwardAuthHostId through a group only. */
  forwardAuthUserId: number;
  /** The raw cookie value of that user's session on that host. */
  forwardAuthToken: string;
  /** The host the write benchmarks update. */
  writeHostId: number;
  monetizedHostIds: number[];
  gateToken: string;
  /** Raw API keys, one per consumer. */
  consumerKeys: string[];
};

export const GATE_TOKEN = sha256Hex("bench-monetization-gate-token");

function geoblock(countries: string[]) {
  return {
    enabled: true,
    block_countries: countries,
    block_continents: [],
    block_asns: [],
    block_cidrs: ["203.0.113.0/24"],
    block_ips: [],
    allow_countries: [],
    allow_continents: [],
    allow_asns: [],
    allow_cidrs: [],
    allow_ips: [],
    trusted_proxies: [],
    fail_closed: false,
    response_status: 403,
    response_body: "Forbidden",
    response_headers: {},
    redirect_url: "",
  };
}

function hostMeta(n: number): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (hostFeatures.forwardAuth(n)) {
    // The built-in forward auth's stored meta key (its pre-rename name, see src/lib/models/proxy-hosts.ts).
    meta.cpm_forward_auth = n % 9 === 0 ? { enabled: true, protected_paths: ["/admin/*"] } : { enabled: true };
  }
  if (hostFeatures.waf(n)) {
    meta.waf = {
      enabled: true,
      mode: "On",
      load_owasp_crs: true,
      waf_mode: "merge",
      ...(n % 10 === 0 ? { excluded_rule_ids: [942100] } : {}),
    };
  }
  if (hostFeatures.geoblock(n)) {
    meta.geoblock = geoblock(["KP", "RU"]);
    meta.geoblock_mode = "merge";
  }
  if (hostFeatures.rateLimit(n)) {
    meta.rate_limit = {
      enabled: true,
      mode: "merge",
      rules: [{ path: "/api/*", methods: [], key: "client_ip", events: 100, window: "1m" }],
    };
  }
  if (hostFeatures.redirects(n)) {
    meta.redirects = [{ from: "/old", to: "/new", status: 301 }];
  }
  if (hostFeatures.locationRules(n)) {
    meta.location_rules = [{ path: "/static/*", upstreams: [`198.51.100.${(n % 250) + 1}:80`] }];
  }
  return meta;
}

/** Fills an empty, migrated database. Synchronous: it runs before any benchmark. */
export function seedBenchDatabase(): SeededIds {
  const accessPasswordHash = bcrypt.hashSync("bench-access-list-password", BCRYPT_SALT);

  return db.transaction((tx) => {
    // ── Users and groups ──
    const userRows = [];
    for (let n = 1; n <= SEED_SIZE.users; n++) {
      userRows.push({
        email: n === 1 ? "admin@example.com" : `user${n}@example.com`,
        name: n === 1 ? "Administrator" : `User ${n}`,
        role: n === 1 ? "admin" : n <= 5 ? "viewer" : "user",
        status: n >= SEED_SIZE.users - 2 ? "disabled" : "active",
        username: n === 1 ? "admin" : `user${n}`,
        emailVerified: true,
        createdAt: createdAt(n),
        updatedAt: createdAt(n),
      });
    }
    const userIds = tx.insert(users).values(userRows).returning({ id: users.id }).all().map((row) => row.id);
    const adminUserId = userIds[0];

    const groupIds = tx
      .insert(groups)
      .values(
        Array.from({ length: SEED_SIZE.groups }, (_, i) => ({
          name: `Team ${i + 1}`,
          description: `Benchmark group ${i + 1}`,
          createdBy: adminUserId,
          createdAt: createdAt(i),
          updatedAt: createdAt(i),
        }))
      )
      .returning({ id: groups.id })
      .all()
      .map((row) => row.id);

    const memberRows: Array<typeof groupMembers.$inferInsert> = [];
    userIds.forEach((userId, index) => {
      const n = index + 1;
      const first = groupIds[n % SEED_SIZE.groups];
      const second = groupIds[(n * 3) % SEED_SIZE.groups];
      memberRows.push({ groupId: first, userId, createdAt: createdAt(n) });
      if (second !== first) memberRows.push({ groupId: second, userId, createdAt: createdAt(n) });
    });
    tx.insert(groupMembers).values(memberRows).run();

    // ── Access lists ──
    const accessListIds = tx
      .insert(accessLists)
      .values(
        Array.from({ length: SEED_SIZE.accessLists }, (_, i) => ({
          name: `Access list ${i + 1}`,
          description: "Benchmark access list",
          createdBy: adminUserId,
          defaultAction: "allow",
          createdAt: createdAt(i),
          updatedAt: createdAt(i),
        }))
      )
      .returning({ id: accessLists.id })
      .all()
      .map((row) => row.id);
    const entryRows: Array<typeof accessListEntries.$inferInsert> = [];
    const ruleRows: Array<typeof accessListRules.$inferInsert> = [];
    accessListIds.forEach((accessListId, i) => {
      for (let e = 1; e <= 3; e++) {
        entryRows.push({ accessListId, username: `client${e}`, passwordHash: accessPasswordHash, createdAt: createdAt(e), updatedAt: createdAt(e) });
      }
      if (i < 10) {
        ruleRows.push(
          { accessListId, position: 0, action: "allow", kind: "ip", matchValues: JSON.stringify([`198.51.100.${i + 1}`]), createdAt: createdAt(i), updatedAt: createdAt(i) },
          { accessListId, position: 1, action: "deny", kind: "country", matchValues: JSON.stringify(["KP"]), createdAt: createdAt(i), updatedAt: createdAt(i) }
        );
      }
    });
    tx.insert(accessListEntries).values(entryRows).run();
    tx.insert(accessListRules).values(ruleRows).run();

    // ── Certificates (managed, one per host for the first hosts) ──
    const certificateIds = tx
      .insert(certificates)
      .values(
        Array.from({ length: SEED_SIZE.managedCertificates }, (_, i) => ({
          name: `Certificate ${i + 1}`,
          type: "managed",
          domainNames: JSON.stringify([`app-${i + 1}.example.com`]),
          autoRenew: true,
          createdBy: adminUserId,
          createdAt: createdAt(i),
          updatedAt: createdAt(i),
        }))
      )
      .returning({ id: certificates.id })
      .all()
      .map((row) => row.id);

    // ── Proxy hosts ──
    const hostRows: Array<typeof proxyHosts.$inferInsert> = [];
    for (let n = 1; n <= SEED_SIZE.proxyHosts; n++) {
      const domains = [`app-${n}.example.com`, ...(n % 10 === 0 ? [`www.app-${n}.example.com`] : [])];
      const upstreams = [`192.0.2.${(n % 250) + 1}:8080`, ...(n % 7 === 0 ? [`198.51.100.${(n % 250) + 1}:8080`] : [])];
      hostRows.push({
        name: `App ${n}`,
        domains: JSON.stringify(domains),
        upstreams: JSON.stringify(upstreams),
        certificateId: n <= SEED_SIZE.managedCertificates ? certificateIds[n - 1] : null,
        accessListId: hostFeatures.accessList(n) ? accessListIds[Math.floor(n / 4) % SEED_SIZE.accessLists] : null,
        ownerUserId: adminUserId,
        sslForced: true,
        hstsEnabled: true,
        hstsSubdomains: n % 6 === 0,
        allowWebsocket: true,
        preserveHostHeader: true,
        meta: JSON.stringify(hostMeta(n)),
        enabled: !hostFeatures.disabled(n),
        tags: JSON.stringify([`team-${n % 5}`]),
        createdAt: createdAt(n),
        updatedAt: createdAt(n),
      });
    }
    const hostIds = tx.insert(proxyHosts).values(hostRows).returning({ id: proxyHosts.id }).all().map((row) => row.id);

    // Forward-auth grants: a group on every protected host, a user directly on most.
    const grantRows: Array<typeof forwardAuthAccess.$inferInsert> = [];
    hostIds.forEach((proxyHostId, index) => {
      const n = index + 1;
      if (!hostFeatures.forwardAuth(n)) return;
      grantRows.push({ proxyHostId, groupId: groupIds[(n / 3) % SEED_SIZE.groups], createdAt: createdAt(n) });
      grantRows.push({ proxyHostId, userId: userIds[((n * 7) % (SEED_SIZE.users - 3)) + 1], createdAt: createdAt(n) });
    });
    tx.insert(forwardAuthAccess).values(grantRows).run();

    // Host 3: forward auth on, granted to group "Team 2" (groupIds[1]) and to
    // user 23 directly. User 9 is in Team 2 (9 % 8 = 1) and not granted
    // directly, so the verify benchmark walks the group path.
    const forwardAuthHostId = hostIds[2];
    const forwardAuthUserId = userIds[8];
    const forwardAuthOrigin = "https://app-3.example.com";
    const forwardAuthToken = sessionToken(0);

    const sessionRows: Array<typeof forwardAuthSessions.$inferInsert> = [
      { userId: forwardAuthUserId, proxyHostId: forwardAuthHostId, audienceOrigin: forwardAuthOrigin, tokenHash: sha256Hex(forwardAuthToken), expiresAt: NEVER_EXPIRES, createdAt: createdAt(0) },
    ];
    for (let s = 1; s < SEED_SIZE.forwardAuthSessions; s++) {
      const n = (s * 3) % SEED_SIZE.proxyHosts || 3;
      sessionRows.push({
        userId: userIds[(s % (SEED_SIZE.users - 3)) + 1],
        proxyHostId: hostIds[n - 1],
        audienceOrigin: `https://app-${n}.example.com`,
        tokenHash: sha256Hex(sessionToken(s)),
        expiresAt: s % 5 === 0 ? createdAt(s) : NEVER_EXPIRES,
        createdAt: createdAt(s),
      });
    }
    tx.insert(forwardAuthSessions).values(sessionRows).run();

    // ── L4 hosts ──
    const l4 = [
      { name: "Postgres", protocol: "tcp", listenAddress: ":5432", upstreams: ["192.0.2.20:5432"], matcherType: "none", matcherValue: null },
      { name: "MySQL", protocol: "tcp", listenAddress: ":3306", upstreams: ["192.0.2.21:3306"], matcherType: "none", matcherValue: null },
      { name: "Redis", protocol: "tcp", listenAddress: ":6379", upstreams: ["192.0.2.22:6379"], matcherType: "none", matcherValue: null },
      { name: "DNS", protocol: "udp", listenAddress: ":5353", upstreams: ["192.0.2.23:53"], matcherType: "none", matcherValue: null },
      { name: "SSH", protocol: "tcp", listenAddress: ":2222", upstreams: ["192.0.2.24:22"], matcherType: "none", matcherValue: null },
      { name: "TLS SNI", protocol: "tcp", listenAddress: ":8443", upstreams: ["192.0.2.25:443", "192.0.2.26:443"], matcherType: "tls_sni", matcherValue: JSON.stringify(["db.example.com"]) },
    ];
    tx.insert(l4ProxyHosts)
      .values(l4.slice(0, SEED_SIZE.l4Hosts).map((host, i) => ({
        ...host,
        upstreams: JSON.stringify(host.upstreams),
        ownerUserId: adminUserId,
        enabled: true,
        createdAt: createdAt(i),
        updatedAt: createdAt(i),
      })))
      .run();

    // ── Settings ──
    const settingRows: Record<string, unknown> = {
      general: { primaryDomain: "example.com", acmeEmail: "ops@example.com" },
      waf: { enabled: true, mode: "DetectionOnly", load_owasp_crs: true, custom_directives: "", excluded_rule_ids: [920350] },
      geoblock: geoblock(["KP"]),
      logging: { enabled: true, format: "json" },
      metrics: { enabled: true, port: 9090 },
      trusted_proxies: { ranges: ["private_ranges"], strict: false },
      monetization_gate: { token: encryptSecret(GATE_TOKEN), installId: "00000000-0000-4000-8000-000000000001" },
      monetization_payments: { currency: "eur" },
    };
    tx.insert(settings)
      .values(Object.entries(settingRows).map(([key, value]) => ({ key, value: JSON.stringify(value), updatedAt: CREATED_AT })))
      .run();

    // WAF exclusions: the global one mirrored in the settings, and the hosts' own.
    const exclusionRows: Array<typeof wafRuleExclusions.$inferInsert> = [
      { ruleId: 920350, proxyHostId: null, reason: "Benchmark", createdBy: adminUserId, createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ];
    hostIds.forEach((proxyHostId, index) => {
      const n = index + 1;
      if (hostFeatures.waf(n) && n % 10 === 0) {
        exclusionRows.push({ ruleId: 942100, proxyHostId, reason: "Benchmark", createdBy: adminUserId, createdAt: CREATED_AT, updatedAt: CREATED_AT });
      }
      if (hostFeatures.waf(n) && n % 15 === 0) {
        exclusionRows.push({ ruleId: 932100, proxyHostId, pathMatch: "prefix", path: "/upload", reason: "Benchmark", createdBy: adminUserId, createdAt: CREATED_AT, updatedAt: CREATED_AT });
      }
    });
    tx.insert(wafRuleExclusions).values(exclusionRows).run();

    // ── API monetization ──
    const planIds = tx
      .insert(monetizationPlans)
      .values([
        { name: "Free", pricePerRequestMicros: 0, includedRequestsPerMonth: 100_000_000, requestsPerMinute: null, createdAt: CREATED_AT, updatedAt: CREATED_AT },
        { name: "Pro", pricePerRequestMicros: 100, includedRequestsPerMonth: 1000, requestsPerMinute: null, createdAt: CREATED_AT, updatedAt: CREATED_AT },
        { name: "Burst", pricePerRequestMicros: 50, includedRequestsPerMonth: 0, requestsPerMinute: null, createdAt: CREATED_AT, updatedAt: CREATED_AT },
      ].slice(0, SEED_SIZE.monetizationPlans))
      .returning({ id: monetizationPlans.id })
      .all()
      .map((row) => row.id);
    const consumerIds = tx
      .insert(monetizationConsumers)
      .values(
        Array.from({ length: SEED_SIZE.monetizationConsumers }, (_, i) => ({
          name: `Consumer ${i + 1}`,
          email: `consumer${i + 1}@example.com`,
          status: "active",
          planId: planIds[i % planIds.length],
          balanceMicros: 1_000_000_000_000,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        }))
      )
      .returning({ id: monetizationConsumers.id })
      .all()
      .map((row) => row.id);
    const consumerKeys: string[] = [];
    tx.insert(monetizationKeys)
      .values(
        consumerIds.map((consumerId, i) => {
          const key = consumerKey(i + 1);
          consumerKeys.push(key.raw);
          return { consumerId, name: "Benchmark", prefix: key.prefix, keyHash: key.hash, createdAt: CREATED_AT };
        })
      )
      .run();
    // Monetization is an authentication mode of its own: hosts without forward auth or an access list.
    const monetizedHostIds = hostIds
      .filter((_, index) => {
        const n = index + 1;
        return !hostFeatures.forwardAuth(n) && !hostFeatures.accessList(n) && !hostFeatures.disabled(n) && n > 100;
      })
      .slice(0, SEED_SIZE.monetizedHosts);
    tx.insert(monetizationHosts)
      .values(monetizedHostIds.map((proxyHostId) => ({ proxyHostId, enabled: true, keyHeader: "Authorization", allowedPlanIds: "[]", createdAt: CREATED_AT, updatedAt: CREATED_AT })))
      .run();

    return {
      adminUserId,
      forwardAuthHostId,
      forwardAuthOrigin,
      forwardAuthUserId,
      forwardAuthToken,
      writeHostId: hostIds[41],
      monetizedHostIds,
      gateToken: GATE_TOKEN,
      consumerKeys,
    };
  });
}

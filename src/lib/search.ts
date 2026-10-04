/**
 * The dashboard search behind the command palette (GET /api/v1/search):
 * hosts, certificates, users, actions, pages, settings and documentation,
 * each group limited to what the caller may read.
 *
 * - Hosts, certificates and users follow the same filters as their lists:
 *   the role's permission, its tag scope (proxy hosts, L4 hosts and
 *   certificates) and the organisation (an organisation user only ever gets
 *   their organisation's rows; a provider-level user the organisation view
 *   the dashboard shows them). Rows are read with only the columns a result
 *   needs: never certificate keys or password hashes.
 * - Actions need the write permission of the page they open; pages, the
 *   permission of their page guard (src/lib/navigation.ts); settings
 *   sections, settings:read plus the section's own permission.
 * - The query is matched literally (LIKE wildcards are escaped), case
 *   insensitively, and cut to MAX_SEARCH_QUERY_LENGTH characters.
 */
import { and, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { appDb } from "./db";
import { certificates, l4ProxyHosts, proxyHosts, users } from "./db/schema";
import { can, listHeldPermissions, scopeTagsFor, tenantOf, type Access, type Permission } from "./permissions";
import { tagsMatchAny } from "./host-tag-filter";
import { certificateIdsInScope } from "./access-scope";
import { NAV_ACCOUNT, NAV_FOOTER, NAV_GROUPS, visibleNavPages, type NavEntryKey } from "./navigation";
import { SETTINGS_SECTIONS, settingsSectionHref } from "./settings-sections";
import { BRAND_NAME, documentationUrl } from "./brand";
import { normalizeSearchQuery, SEARCH_LIMITS, type SearchResponse, type SearchResult, type SearchRunAction } from "./search-results";
import { organizationCondition, type OrganizationFilter } from "@/ee/multi-tenancy/scope";
import { dashboardOrganizationFilter } from "@/ee/multi-tenancy/view";
import { brandName } from "@/ee/white-label/store";
import { asc, likeText } from "@/src/lib/db/ops";

/** Rows read per table before ranking, so the best matches win over the first ones. */
const CANDIDATES = 25;

export type SearchOptions = {
  /**
   * The organisation filter for hosts, certificates and users; by default the
   * one the dashboard's lists use for the caller (dashboardOrganizationFilter).
   * Ignored for organisation users, who always get their own organisation.
   */
  organizationFilter?: OrganizationFilter;
};

// ── Matching ──────────────────────────────────────────────────────────

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `column` contains `query` literally (SQLite's LIKE is case-insensitive for ASCII). */
function contains(column: SQLiteColumn, query: string): SQL {
  return likeText(column, `%${escapeLike(query)}%`);
}

/**
 * How well a text item matches: 0 the title starts with the query, 1 the
 * title contains it, 2 every word of the query is in the title, subtitle or
 * keywords; null no match.
 */
export function matchRank(query: string, title: string, extra: readonly string[] = []): number | null {
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  if (t.startsWith(q)) return 0;
  if (t.includes(q)) return 1;
  const haystack = [t, ...extra.map((value) => value.toLowerCase())].join(" ");
  if (haystack.includes(q)) return 2;
  const words = q.split(" ").filter(Boolean);
  return words.length > 1 && words.every((word) => haystack.includes(word)) ? 2 : null;
}

function ranked<T>(items: readonly T[], rank: (item: T) => number | null, limit: number): T[] {
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .filter((entry): entry is { item: T; index: number; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

const HOST_NAME = /^[a-z0-9*][a-z0-9.*-]*$/i;
const DOMAIN_LIKE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

function parseList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function result(fields: Omit<SearchResult, "external" | "mono" | "run" | "verb"> & Partial<Pick<SearchResult, "external" | "mono" | "run" | "verb">>): SearchResult {
  return { external: false, mono: false, run: null, verb: "Open", ...fields };
}

// ── Hosts, certificates, users ────────────────────────────────────────

async function searchProxyHosts(access: Access, query: string, organization: OrganizationFilter) {
  const scope = scopeTagsFor(access, "proxy_hosts");
  const rows = await appDb
    .select({ id: proxyHosts.id, name: proxyHosts.name, domains: proxyHosts.domains, enabled: proxyHosts.enabled })
    .from(proxyHosts)
    .where(and(
      or(contains(proxyHosts.name, query), contains(proxyHosts.domains, query)),
      scope ? tagsMatchAny(proxyHosts.tags, scope) : undefined,
      organizationCondition(proxyHosts.organizationId, organization)
    ))
    .orderBy(asc(proxyHosts.name), asc(proxyHosts.id))
    .limit(CANDIDATES);
  const q = query.toLowerCase();
  const hosts = rows.map((row) => {
    const domains = parseList(row.domains);
    const domain = domains.find((d) => d.toLowerCase().includes(q)) ?? domains[0] ?? row.name;
    return { ...row, domains, domain };
  });
  const exact = hosts.some((host) => host.domains.some((d) => d.toLowerCase() === q));
  const top = ranked(hosts, (host) => matchRank(query, host.domain, [host.name]), SEARCH_LIMITS.proxyHosts);
  return {
    exact,
    results: top.map((host) => result({
      group: "hosts",
      kind: "proxy_host",
      id: `proxy_host:${host.id}`,
      title: host.domain,
      subtitle: ["Proxy host", host.name !== host.domain ? host.name : null, host.domains.length > 1 ? `${host.domains.length} domains` : null, host.enabled ? null : "disabled"]
        .filter(Boolean)
        .join(" · "),
      href: `/proxy-hosts?search=${encodeURIComponent(host.domain)}`,
      mono: HOST_NAME.test(host.domain),
    })),
  };
}

async function searchL4Hosts(access: Access, query: string): Promise<SearchResult[]> {
  const scope = scopeTagsFor(access, "l4_proxy_hosts");
  const rows = await appDb
    .select({ id: l4ProxyHosts.id, name: l4ProxyHosts.name, protocol: l4ProxyHosts.protocol, listenAddress: l4ProxyHosts.listenAddress, enabled: l4ProxyHosts.enabled })
    .from(l4ProxyHosts)
    .where(and(or(contains(l4ProxyHosts.name, query), contains(l4ProxyHosts.listenAddress, query)), scope ? tagsMatchAny(l4ProxyHosts.tags, scope) : undefined))
    .orderBy(asc(l4ProxyHosts.name), asc(l4ProxyHosts.id))
    .limit(CANDIDATES);
  return ranked(rows, (row) => matchRank(query, row.name, [row.listenAddress]), SEARCH_LIMITS.l4Hosts).map((row) =>
    result({
      group: "hosts",
      kind: "l4_proxy_host",
      id: `l4_proxy_host:${row.id}`,
      title: row.name,
      subtitle: ["L4 host", `${row.protocol.toUpperCase()} ${row.listenAddress}`, row.enabled ? null : "disabled"].filter(Boolean).join(" · "),
      href: `/l4-proxy-hosts?search=${encodeURIComponent(row.name)}`,
      mono: HOST_NAME.test(row.name),
    })
  );
}

async function searchCertificates(access: Access, query: string, organization: OrganizationFilter): Promise<SearchResult[]> {
  const rows = await appDb
    .select({ id: certificates.id, name: certificates.name, type: certificates.type, domainNames: certificates.domainNames })
    .from(certificates)
    .where(and(or(contains(certificates.name, query), contains(certificates.domainNames, query)), organizationCondition(certificates.organizationId, organization)))
    .orderBy(asc(certificates.name), asc(certificates.id))
    .limit(CANDIDATES * 4);
  const inScope = await certificateIdsInScope(access);
  const visible = rows.filter((row) => inScope === null || inScope.has(row.id)).map((row) => ({ ...row, domains: parseList(row.domainNames) }));
  return ranked(visible, (row) => matchRank(query, row.name, row.domains), SEARCH_LIMITS.certificates).map((row) =>
    result({
      group: "certificates",
      kind: "certificate",
      id: `certificate:${row.id}`,
      title: row.name,
      subtitle: [row.type === "imported" ? "Imported certificate" : "Managed certificate", row.domains.slice(0, 2).join(", ") || null, row.domains.length > 2 ? `${row.domains.length - 2} more` : null]
        .filter(Boolean)
        .join(" · "),
      href: "/certificates",
      mono: HOST_NAME.test(row.name),
    })
  );
}

async function searchUsers(query: string, organization: OrganizationFilter): Promise<SearchResult[]> {
  // Only the columns a result shows: never passwordHash or anything secret.
  const rows = await appDb
    .select({ id: users.id, name: users.name, email: users.email, username: users.username, status: users.status })
    .from(users)
    .where(and(or(contains(users.email, query), contains(users.name, query), contains(users.username, query)), organizationCondition(users.organizationId, organization)))
    .orderBy(asc(users.email), asc(users.id))
    .limit(CANDIDATES);
  return ranked(rows, (row) => matchRank(query, row.name || row.email, [row.email, row.username ?? ""]), SEARCH_LIMITS.users).map((row) =>
    result({
      group: "users",
      kind: "user",
      id: `user:${row.id}`,
      title: row.name || row.email,
      subtitle: ["User", row.name ? row.email : null, row.status !== "active" ? row.status : null].filter(Boolean).join(" · "),
      href: "/users",
    })
  );
}

// ── Actions ───────────────────────────────────────────────────────────

type ActionDef = {
  id: string;
  title: string;
  subtitle: string;
  keywords: readonly string[];
  href: string;
  run?: SearchRunAction;
  /** Every permission the action needs (it opens a page whose guard checks the read one). */
  permissions: readonly Permission[];
};

const ACTIONS: readonly ActionDef[] = [
  {
    id: "create-proxy-host",
    title: "Create a proxy host",
    subtitle: "Domain, upstream and protection",
    keywords: ["new", "add", "host", "proxy", "domain", "site"],
    href: "/proxy-hosts/new",
    permissions: ["proxy_hosts:write"],
  },
  {
    id: "add-access-list",
    title: "Add an access list",
    subtitle: "Basic auth users and allowed addresses",
    keywords: ["access", "acl", "basic auth", "allow", "deny", "new"],
    href: "/access-lists",
    permissions: ["access_lists:write"],
  },
  {
    id: "import-certificate",
    title: "Import a certificate",
    subtitle: "PEM certificate and private key",
    keywords: ["certificate", "cert", "tls", "ssl", "pem", "upload"],
    href: "/certificates",
    permissions: ["certificates:write"],
  },
  {
    id: "add-user",
    title: "Add a user",
    subtitle: "Administrator, user or viewer",
    keywords: ["user", "invite", "teammate", "account", "new"],
    href: "/users",
    permissions: ["users:write"],
  },
  {
    id: "apply-config",
    title: "Apply the configuration to Caddy",
    subtitle: "Rebuild and load the Caddy configuration now",
    keywords: ["apply", "reload", "caddy", "config", "configuration"],
    href: "/settings",
    run: "apply_config",
    permissions: ["settings:write"],
  },
];

function actionResult(action: ActionDef, overrides: Partial<SearchResult> = {}): SearchResult {
  return result({
    group: "actions",
    kind: "action",
    id: `action:${action.id}`,
    title: action.title,
    subtitle: action.subtitle,
    href: action.href,
    run: action.run ?? null,
    verb: action.run ? "Run" : "Open",
    ...overrides,
  });
}

function allowedActions(access: Access): ActionDef[] {
  return ACTIONS.filter((action) => action.permissions.every((permission) => can(access, permission)));
}

// ── Pages, settings, documentation ────────────────────────────────────

const ENTRY_GROUP = new Map<NavEntryKey, string>([
  ...NAV_GROUPS.flatMap((group) => group.entries.map((entry) => [entry.key, group.title ?? "Dashboard"] as [NavEntryKey, string])),
  ...NAV_FOOTER.map((entry) => [entry.key, "Dashboard"] as [NavEntryKey, string]),
  ...NAV_ACCOUNT.map((entry) => [entry.key, "Your account"] as [NavEntryKey, string]),
]);
const ENTRY_LABEL = new Map<NavEntryKey, string>(
  [...NAV_GROUPS.flatMap((group) => group.entries), ...NAV_FOOTER, ...NAV_ACCOUNT].map((entry) => [entry.key, entry.label])
);

/** Words that also find a page; a page that took over another keeps the old page's name here. */
const PAGE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "/security": ["waf events", "blocked requests", "attacks", "block an address", "firewall"],
};

function pageResults(access: Access): (SearchResult & { keywords: string[] })[] {
  return visibleNavPages({ permissions: listHeldPermissions(access), isAdmin: access.isAdmin }).map((page) => {
    const entryLabel = ENTRY_LABEL.get(page.entry) ?? "";
    return {
      ...result({
        group: "pages",
        kind: "page",
        id: `page:${page.href}`,
        title: page.label,
        subtitle: [ENTRY_GROUP.get(page.entry) ?? null, entryLabel && entryLabel !== page.label ? entryLabel : null].filter(Boolean).join(" · ") || null,
        href: page.href,
      }),
      keywords: [entryLabel, ...(PAGE_KEYWORDS[page.href] ?? [])],
    };
  });
}

/** Settings that live on other pages, shown with the settings sections. */
const OTHER_SETTINGS: readonly { id: string; title: string; subtitle: string; keywords: readonly string[]; href: string; permission: Permission | null }[] = [
  { id: "api-tokens", title: "API tokens", subtitle: "Profile · Bearer tokens for /api/v1", keywords: ["token", "bearer", "rest", "api key"], href: "/profile", permission: null },
  { id: "mfa", title: "Multi-factor authentication", subtitle: "Profile · authenticator app and backup codes", keywords: ["mfa", "totp", "2fa", "two-factor"], href: "/profile", permission: null },
  { id: "waf", title: "WAF settings", subtitle: "WAF · global mode, rules and exclusions", keywords: ["waf", "coraza", "crs", "owasp", "firewall", "exclusion"], href: "/waf", permission: "waf:read" },
  { id: "branding", title: "Branding", subtitle: "Product name, logos and colours", keywords: ["white label", "logo", "colour", "color", "theme"], href: "/branding", permission: "branding:read" },
];

function settingsResults(access: Access): (SearchResult & { keywords: readonly string[] })[] {
  const sections = can(access, "settings:read")
    ? SETTINGS_SECTIONS.filter((section) => !section.permission || can(access, section.permission)).map((section) => ({
        ...result({
          group: "settings",
          kind: "setting",
          id: `setting:${section.id}`,
          title: section.name,
          subtitle: `Settings · ${section.groupLabel} · ${section.desc}`,
          href: settingsSectionHref(section.id),
        }),
        keywords: section.keywords,
      }))
    : [];
  const others = OTHER_SETTINGS.filter((item) => item.permission === null || can(access, item.permission)).map((item) => ({
    ...result({ group: "settings", kind: "setting", id: `setting:${item.id}`, title: item.title, subtitle: item.subtitle, href: item.href }),
    keywords: item.keywords,
  }));
  return [...sections, ...others];
}

/** Documentation pages: their file in documentation/ or ee/docs/ (see documentationUrl). */
const DOCS: readonly { id: string; title: string; subtitle: string; keywords: readonly string[]; path: string }[] = [
  { id: "command-palette", title: "Search and the command palette", subtitle: "Ctrl+K or ⌘K, and GET /api/v1/search", keywords: ["search", "palette", "shortcut", "keyboard"], path: "documentation/command-palette.md" },
  { id: "certificates", title: "Certificates", subtitle: "ACME and imported certificates, renewal, CAs and client certificates", keywords: ["tls", "ssl", "acme", "lets encrypt", "expiry", "renewal", "mtls", "client certificates"], path: "documentation/certificates.md" },
  { id: "access-lists", title: "Access lists", subtitle: "Address, country and network rules, members and blocked sources", keywords: ["allow", "deny", "ip", "cidr", "basic auth", "blocked sources"], path: "documentation/access-lists.md" },
  { id: "analytics", title: "Traffic analytics", subtitle: "What each request records, filters and saved views", keywords: ["clickhouse", "traffic", "requests", "retention", "charts"], path: "documentation/analytics.md" },
  { id: "waf", title: "Web application firewall", subtitle: "Modes, the Core Rule Set, exclusions and custom rules", keywords: ["waf", "coraza", "owasp", "crs", "exclusions", "false positive"], path: "documentation/waf.md" },
  { id: "audit-log", title: "Audit log", subtitle: "Every change and sign-in, with filters and diffs", keywords: ["audit", "events", "changes", "who did"], path: "documentation/audit-log.md" },
  { id: "profile", title: "Profile, sessions and API tokens", subtitle: "Your account, how you sign in, sessions and tokens", keywords: ["profile", "password", "passkey", "sessions", "api token", "bearer"], path: "documentation/profile.md" },
  { id: "settings", title: "Settings", subtitle: "Defaults for every host and how this install runs", keywords: ["settings", "defaults", "configuration"], path: "documentation/settings.md" },
  { id: "postgresql", title: "PostgreSQL", subtitle: "Run on PostgreSQL, and move an install from SQLite", keywords: ["postgres", "postgresql", "database", "sqlite", "migrate", "copy", "docker compose", "backup"], path: "documentation/postgresql.md" },
  { id: "setup-checklist", title: "Setup checklist", subtitle: "The first steps on a fresh install", keywords: ["setup", "onboarding", "getting started", "checklist"], path: "documentation/setup-checklist.md" },
  { id: "needs-attention", title: "Needs attention", subtitle: "What the overview flags, and who sees it", keywords: ["attention", "overview", "problems", "warnings"], path: "documentation/needs-attention.md" },
  { id: "rate-limiting", title: "Rate limiting", subtitle: "Rules, keys and windows", keywords: ["429", "limit", "throttle"], path: "documentation/rate-limiting.md" },
  { id: "security-events", title: "Security events", subtitle: "What was stopped, why, and what to do about it", keywords: ["waf", "events", "blocked", "false positive", "exclusion"], path: "documentation/security-events.md" },
  { id: "users-and-groups", title: "Users and groups", subtitle: "Users, groups and roles, second factors and sessions", keywords: ["users", "groups", "roles", "accounts", "invite", "disable"], path: "documentation/users-and-groups.md" },
  { id: "sign-in-and-directories", title: "Sign-in and directories", subtitle: "Enforced SSO, OIDC, SAML, LDAP and SCIM on one page", keywords: ["sign-in", "sso", "oidc", "saml", "ldap", "scim", "break-glass"], path: "documentation/sign-in-and-directories.md" },
  { id: "mfa", title: "Multi-factor authentication", subtitle: "Authenticator codes, backup codes, policy", keywords: ["mfa", "totp", "2fa", "two-factor"], path: "documentation/mfa.md" },
  { id: "host-tags", title: "Host tags", subtitle: "Labels on hosts, and roles limited to them", keywords: ["tags", "labels", "scope"], path: "documentation/host-tags.md" },
  { id: "usage-ping", title: "Anonymous usage ping", subtitle: "Exactly what is sent, and the privacy notice", keywords: ["usage", "telemetry", "privacy"], path: "documentation/usage-ping.md" },
  { id: "charts", title: "Charts", subtitle: "Reading the traffic charts with a mouse, keyboard or screen reader", keywords: ["charts", "graphs", "keyboard", "screen reader"], path: "documentation/charts.md" },
  { id: "licenses", title: "Licenses", subtitle: "Buying, trials, installing keys and automatic updates", keywords: ["license", "key", "trial", "renewal", "stripe", "refresh token", "edition"], path: "ee/docs/licenses.md" },
  { id: "custom-roles", title: "Custom roles and permissions", subtitle: "Permissions, tag scopes and the endpoint table", keywords: ["roles", "rbac", "permissions", "scope"], path: "ee/docs/custom-roles.md" },
  { id: "sso-enforcement", title: "Enforced single sign-on", subtitle: "Break-glass accounts and lockout guards", keywords: ["sso", "break-glass", "enforce"], path: "ee/docs/sso-enforcement.md" },
  { id: "sso-saml", title: "SAML sign-in", subtitle: "Entra ID, Okta and other SAML providers", keywords: ["saml", "sso", "entra", "okta"], path: "ee/docs/sso-saml.md" },
  { id: "ldap", title: "LDAP and Active Directory", subtitle: "Directory sign-in and group mapping", keywords: ["ldap", "active directory", "ad", "directory"], path: "ee/docs/ldap.md" },
  { id: "scim", title: "SCIM provisioning", subtitle: "Users and groups from your identity provider", keywords: ["scim", "provisioning"], path: "ee/docs/scim.md" },
  { id: "access-reviews", title: "Access reviews", subtitle: "Campaigns, reviewers and decisions", keywords: ["review", "recertification", "audit"], path: "ee/docs/access-reviews.md" },
  { id: "alerting", title: "Alerting", subtitle: "Channels, rules and history", keywords: ["alerts", "notifications", "pagerduty", "slack", "email"], path: "ee/docs/alerting.md" },
  { id: "ai-analyst", title: "AI analyst", subtitle: "Alert explanations, the daily digest and WAF tuning, with your own model", keywords: ["ai", "llm", "model", "digest", "explanation"], path: "ee/docs/ai-analyst.md" },
  { id: "analytics-questions", title: "Analytics questions", subtitle: "Ask about traffic in plain language, and what the model sees", keywords: ["ask", "question", "ai", "natural language", "privacy"], path: "ee/docs/analytics-questions.md" },
  { id: "api-monetization", title: "API monetization guide", subtitle: "Charge per request: prepaid, postpaid or x402", keywords: ["stripe", "billing", "plans", "postpaid", "x402", "usdc"], path: "ee/docs/api-monetization.md" },
  { id: "change-approvals", title: "Change approvals", subtitle: "Policies, requests and emergency changes", keywords: ["approvals", "four eyes", "change request"], path: "ee/docs/change-approvals.md" },
  { id: "config-history", title: "Configuration history", subtitle: "Snapshots, diffs and rollback", keywords: ["history", "rollback", "snapshot"], path: "ee/docs/config-history.md" },
  { id: "compliance-reports", title: "Compliance reports", subtitle: "Access, change and certificate reports", keywords: ["compliance", "nis2", "report"], path: "ee/docs/compliance-reports.md" },
  { id: "fleet", title: "Fleet management", subtitle: "Environments, promotions and drift", keywords: ["fleet", "environments", "promote", "replicas"], path: "ee/docs/fleet.md" },
  { id: "high-availability", title: "High availability", subtitle: "Shared certificate storage, shared request-path state, a dashboard cluster with failover and PostgreSQL replicas", keywords: ["redis", "valkey", "cluster", "ha", "failover", "standby", "litestream", "replication", "shared state", "sessions", "balances", "postgresql", "replicas", "leader election", "load balancer", "upstreams", "health check"], path: "ee/docs/high-availability.md" },
  { id: "multi-tenancy", title: "Multi-tenancy", subtitle: "Client organisations and their limits", keywords: ["organisations", "organizations", "tenants", "msp"], path: "ee/docs/multi-tenancy.md" },
  { id: "white-label", title: "White-label branding", subtitle: "Product name, logos and colours", keywords: ["branding", "white label", "logo"], path: "ee/docs/white-label.md" },
  { id: "scheduled-backups", title: "Scheduled backups", subtitle: "Encrypted backups to S3-compatible storage", keywords: ["backup", "s3", "restore"], path: "ee/docs/scheduled-backups.md" },
  { id: "virtual-patching", title: "Virtual patching", subtitle: "WAF rules for new CVEs from a signed feed", keywords: ["cve", "virtual patch", "rule feed", "waf"], path: "ee/docs/virtual-patching.md" },
  { id: "audit-streaming", title: "Audit streaming", subtitle: "Send the audit log to a SIEM", keywords: ["siem", "syslog", "audit", "retention"], path: "ee/docs/audit-streaming.md" },
];

/**
 * Documentation results. The published documentation describes the
 * upstream product, so a white-labelled dashboard (a product name of its
 * own) does not link to it; the in-app REST API reference stays.
 */
function docResults(access: Access): (SearchResult & { keywords: readonly string[] })[] {
  const out: (SearchResult & { keywords: readonly string[] })[] = [];
  if (can(access, "api_docs:read")) {
    out.push({
      ...result({ group: "docs", kind: "doc", id: "doc:api-reference", title: "REST API reference", subtitle: "Every /api/v1 endpoint, with examples", href: "/api-docs", verb: "Read" }),
      keywords: ["openapi", "rest", "endpoint", "api", "swagger"],
    });
  }
  if (brandName() !== BRAND_NAME) return out;
  for (const doc of DOCS) {
    out.push({
      ...result({ group: "docs", kind: "doc", id: `doc:${doc.id}`, title: doc.title, subtitle: doc.subtitle, href: documentationUrl(doc.path), external: true, verb: "Read" }),
      keywords: doc.keywords,
    });
  }
  return out;
}

function strip<T extends SearchResult>(item: T & { keywords?: unknown }): SearchResult {
  const { keywords: _keywords, ...rest } = item;
  void _keywords;
  return rest;
}

function matchStatic<T extends SearchResult & { keywords: readonly string[] }>(query: string, items: readonly T[], limit: number): SearchResult[] {
  return ranked(items, (item) => matchRank(query, item.title, [item.subtitle ?? "", ...item.keywords]), limit).map(strip);
}

// ── Search ────────────────────────────────────────────────────────────

/** Suggestions for an empty query: the common actions, then a few pages. */
function suggestions(access: Access): SearchResult[] {
  const actions = allowedActions(access).slice(0, SEARCH_LIMITS.actions).map((action) => actionResult(action));
  const pages = pageResults(access).slice(0, 6).map(strip);
  return [...actions, ...pages];
}

export async function searchDashboard(access: Access, rawQuery: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return { query, results: suggestions(access) };

  const tenant = tenantOf(access);
  const organization: OrganizationFilter =
    tenant !== null ? tenant : "organizationFilter" in options ? options.organizationFilter : await dashboardOrganizationFilter(access);

  const results: SearchResult[] = [];
  let exactHost = false;
  if (can(access, "proxy_hosts:read")) {
    const hosts = await searchProxyHosts(access, query, organization);
    exactHost = hosts.exact;
    results.push(...hosts.results);
  }
  // L4 hosts belong to the provider level: organisation users never get them.
  if (tenant === null && can(access, "l4_proxy_hosts:read")) results.push(...(await searchL4Hosts(access, query)));
  if (can(access, "certificates:read")) results.push(...(await searchCertificates(access, query, organization)));
  if (can(access, "users:read")) results.push(...(await searchUsers(query, organization)));

  // Actions: a host name that no visible host has yet offers to create it.
  const allowed = allowedActions(access);
  const actions: SearchResult[] = [];
  const create = allowed.find((action) => action.id === "create-proxy-host");
  if (create && !exactHost && DOMAIN_LIKE.test(query)) {
    actions.push(
      actionResult(create, {
        id: "action:create-proxy-host:domain",
        subtitle: `Opens the form with “${query}” as the domain`,
        href: `/proxy-hosts/new?domain=${encodeURIComponent(query.toLowerCase())}`,
        noHighlight: true,
      })
    );
  }
  const matched = ranked(allowed, (action) => matchRank(query, action.title, [action.subtitle, ...action.keywords]), SEARCH_LIMITS.actions);
  for (const action of matched) if (actions.length < SEARCH_LIMITS.actions) actions.push(actionResult(action));
  results.push(...actions);

  results.push(...matchStatic(query, pageResults(access), SEARCH_LIMITS.pages));
  results.push(...matchStatic(query, settingsResults(access), SEARCH_LIMITS.settings));
  results.push(...matchStatic(query, docResults(access), SEARCH_LIMITS.docs));
  return { query, results };
}

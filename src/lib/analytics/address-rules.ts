/**
 * The address rules of the geoblocking settings: every block_ips and
 * block_cidrs entry of the global settings and of each proxy host. caddy-
 * blocker logs the same "request blocked" for every kind of rule, so the
 * log parser tells an address rule ("access") from a country, continent or
 * AS number rule ("geo") by checking whether the blocked client address is
 * listed in one of them (outcome.ts). Cached for a minute.
 */
import { BlockList, isIP } from 'node:net';
import { appDb } from '../db';
import { proxyHosts } from '../db/schema';
import type { GeoBlockSettings } from '../settings';

const CACHE_MS = 60_000;

let cached: { list: BlockList; loadedAt: number } | null = null;

/** Adds one block_ips / block_cidrs entry to `list`; malformed entries are skipped. */
function addEntry(list: BlockList, entry: unknown): void {
  if (typeof entry !== 'string') return;
  const value = entry.trim();
  if (!value) return;
  const slash = value.indexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  const family = isIP(address);
  if (family === 0) return;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  try {
    if (slash === -1) {
      list.addAddress(address, type);
    } else {
      const prefix = Number(value.slice(slash + 1));
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) return;
      list.addSubnet(address, prefix, type);
    }
  } catch {
    // A rule Caddy would refuse too; it blocks nothing.
  }
}

function addSettings(list: BlockList, settings: Partial<GeoBlockSettings> | null | undefined): void {
  if (!settings || typeof settings !== 'object') return;
  for (const entry of Array.isArray(settings.block_ips) ? settings.block_ips : []) addEntry(list, entry);
  for (const entry of Array.isArray(settings.block_cidrs) ? settings.block_cidrs : []) addEntry(list, entry);
}

/** Builds the list from the given settings (tests) or from the database. */
export function buildAddressRuleList(settings: Array<Partial<GeoBlockSettings> | null | undefined>): BlockList {
  const list = new BlockList();
  for (const entry of settings) addSettings(list, entry);
  return list;
}

async function loadAddressRules(): Promise<BlockList> {
  const settings: Array<Partial<GeoBlockSettings> | null> = [];
  try {
    // Imported here: settings.ts pulls in the proxy host model, which the log
    // parser does not otherwise need.
    const { getGeoBlockSettings } = await import('../settings');
    settings.push(await getGeoBlockSettings());
  } catch {
    // No readable global settings: only the hosts' rules count.
  }
  try {
    const rows = await appDb.select({ meta: proxyHosts.meta }).from(proxyHosts);
    for (const row of rows) {
      if (!row.meta) continue;
      try {
        settings.push((JSON.parse(row.meta) as { geoblock?: Partial<GeoBlockSettings> | null }).geoblock ?? null);
      } catch {
        // A malformed row has no rules.
      }
    }
  } catch {
    // The database is unavailable: no address rules.
  }
  return buildAddressRuleList(settings);
}

/** The cached address rule list, reloaded at most once a minute. */
export async function getAddressRuleList(now = Date.now()): Promise<BlockList> {
  if (cached && now - cached.loadedAt < CACHE_MS) return cached.list;
  const list = await loadAddressRules();
  cached = { list, loadedAt: now };
  return list;
}

/** True when `ip` is listed in an address rule of `list`. */
export function inAddressRules(list: BlockList | null | undefined, ip: string): boolean {
  if (!list || !ip) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  try {
    return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
}

/** Forgets the cached list (tests). */
export function resetAddressRuleCache(): void {
  cached = null;
}

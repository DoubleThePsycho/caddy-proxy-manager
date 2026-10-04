/**
 * Whether the GeoLite2 databases Caddy and the log parser read are present.
 * Shared by GET /api/geoip-status (the host dialog's badge) and the Settings
 * page's GeoIP card. Server only.
 */
import { existsSync, statSync } from "node:fs";

export const GEOIP_COUNTRY_DB = "/usr/share/GeoIP/GeoLite2-Country.mmdb";
export const GEOIP_ASN_DB = "/usr/share/GeoIP/GeoLite2-ASN.mmdb";

/** What /api/geoip-status answers: which of the two databases exist. */
export function getGeoIpStatus(): { country: boolean; asn: boolean } {
  return { country: existsSync(GEOIP_COUNTRY_DB), asn: existsSync(GEOIP_ASN_DB) };
}

export type GeoIpDatabaseView = {
  name: "GeoLite2 Country" | "GeoLite2 ASN";
  path: string;
  found: boolean;
  /** When the file was last written (ISO), null when missing or unreadable. */
  updatedAt: string | null;
};

function databaseView(name: GeoIpDatabaseView["name"], path: string): GeoIpDatabaseView {
  try {
    const stat = statSync(path);
    return { name, path, found: stat.isFile(), updatedAt: stat.isFile() ? stat.mtime.toISOString() : null };
  } catch {
    return { name, path, found: false, updatedAt: null };
  }
}

/** Both databases with their paths and file dates, for the Settings page. */
export function getGeoIpDatabases(): GeoIpDatabaseView[] {
  return [databaseView("GeoLite2 Country", GEOIP_COUNTRY_DB), databaseView("GeoLite2 ASN", GEOIP_ASN_DB)];
}

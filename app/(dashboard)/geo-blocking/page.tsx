import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getGeoBlockSettings } from "@/src/lib/settings";
import { getGeoIpDatabases } from "@/src/lib/geoip-status";
import GeoBlockingClient from "./GeoBlockingClient";

export const metadata = { title: "Geo blocking" };

export default async function GeoBlockingPage() {
  const { access } = await requirePermission("settings:read");
  const geoblock = await getGeoBlockSettings();
  return (
    <GeoBlockingClient
      geoblock={geoblock}
      geoip={getGeoIpDatabases()}
      canSave={can(access, "settings:write")}
      canOpenSecurity={can(access, "waf:read")}
    />
  );
}

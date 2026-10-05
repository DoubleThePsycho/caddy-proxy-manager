import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getRateLimitSettings } from "@/src/lib/settings";
import RateLimitingClient from "./RateLimitingClient";

export const metadata = { title: "Rate limiting" };

export default async function RateLimitingPage() {
  const { access } = await requirePermission("settings:read");
  const rateLimit = await getRateLimitSettings();
  return (
    <RateLimitingClient rateLimit={rateLimit} canSave={can(access, "settings:write")} canOpenSecurity={can(access, "waf:read")} />
  );
}

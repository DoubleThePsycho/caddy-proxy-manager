import type { NextRequest } from "next/server";

/**
 * The WAF events list moved to Security events (/security). Old links and
 * bookmarks land there with the WAF filter and their time range; the page
 * itself checks waf:read. The Location is relative, so the redirect stays on
 * the host the browser used, whatever Next.js thinks its own origin is.
 */
export function GET(request: NextRequest): Response {
  const source = request.nextUrl.searchParams;
  const target = new URLSearchParams({ kind: "waf" });
  const range = source.get("range");
  if (range === "24h" || range === "7d" || range === "30d") {
    target.set("range", range);
  } else if (range === "custom") {
    const from = source.get("from") ?? "";
    const to = source.get("to") ?? "";
    if (/^\d{1,12}$/.test(from) && /^\d{1,12}$/.test(to)) {
      target.set("range", "custom");
      target.set("from", from);
      target.set("to", to);
    }
  }
  return new Response(null, { status: 307, headers: { Location: `/security?${target.toString()}` } });
}

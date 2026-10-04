import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { filterManagedCertificatesForAccess, getManagedCertificates } from "@/src/lib/managed-certificates";

/** A forced re-check never probes a name checked less than this long ago. */
const MIN_REFRESH_AGE_MS = 60_000;

/**
 * Certificates Caddy manages for enabled proxy hosts, read from Caddy with a
 * TLS handshake per domain (src/lib/managed-certificates.ts). ?refresh=true
 * waits for a fresh check; otherwise cached results are returned and stale
 * ones are re-checked in the background.
 */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "certificates:read");
    const refresh = request.nextUrl.searchParams.get("refresh") === "true";
    const report = await getManagedCertificates(refresh ? { maxAgeMs: MIN_REFRESH_AGE_MS } : { cachedOnly: true });
    const certificates = await filterManagedCertificatesForAccess(report.certificates, access);
    return NextResponse.json(
      { available: report.available, reason: report.reason, unchecked: report.unchecked, certificates },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

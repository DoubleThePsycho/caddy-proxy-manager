// SPDX-License-Identifier: Elastic-2.0
/**
 * Whether this process was refused as a PostgreSQL replica (src/lib/cluster-nodes.ts,
 * D6): a new replica that another live replica is running next to, without
 * a license that includes high availability. A refused replica serves
 * nothing but its health check (proxy.ts answers everything else with 503
 * and the reason) until it is admitted; it tries again on its own.
 *
 * Kept on globalThis: proxy.ts, the routes and instrumentation load their
 * own copies of modules in one process. No imports beyond next/server, so
 * proxy.ts stays light.
 */
import { NextResponse } from "next/server";

type GlobalAdmissionState = typeof globalThis & { __ingressiReplicaRefusal?: string };
const store = globalThis as GlobalAdmissionState;

/** Sets (a message) or clears (null) this process's refusal. */
export function setReplicaRefusal(message: string | null): void {
  store.__ingressiReplicaRefusal = message ?? undefined;
}

/** Why this replica was refused, or null. */
export function replicaRefusal(): string | null {
  return store.__ingressiReplicaRefusal ?? null;
}

export const REFUSED_HEADERS = {
  "Cache-Control": "no-store",
  "Retry-After": "30",
  "X-HA-Role": "refused",
} as const;

/** The answer of a refused replica to every request but the health check. */
export function replicaRefusedResponse(pathname: string, message: string): NextResponse {
  if (pathname.startsWith("/api/") || pathname.startsWith("/scim/")) {
    return NextResponse.json({ error: message, role: "refused" }, { status: 503, headers: REFUSED_HEADERS });
  }
  return new NextResponse(`${message}\n`, {
    status: 503,
    headers: {
      ...REFUSED_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// SPDX-License-Identifier: Elastic-2.0
/**
 * The answer a high availability standby gives to dashboard and API requests
 * (proxy.ts): 503 with a short explanation, so a load balancer that still
 * sends traffic here, or a person who reaches the node directly, learns why.
 * Health checks and the request-path routes (ee/high-availability/request-path.ts) are
 * never answered with it.
 */
import { NextResponse } from "next/server";

export const STANDBY_MESSAGE =
  "This node is a high availability standby. The dashboard and the API are served by the leader; " +
  "send requests to the load balancer in front of the cluster.";

export const STANDBY_HEADERS = {
  "Cache-Control": "no-store",
  "Retry-After": "5",
  "X-HA-Role": "standby",
} as const;

export function standbyResponse(pathname: string): NextResponse {
  if (pathname.startsWith("/api/") || pathname.startsWith("/scim/")) {
    return NextResponse.json({ error: STANDBY_MESSAGE, role: "standby" }, { status: 503, headers: STANDBY_HEADERS });
  }
  return new NextResponse(`${STANDBY_MESSAGE}\n`, {
    status: 503,
    headers: {
      ...STANDBY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

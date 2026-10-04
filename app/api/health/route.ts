import { NextResponse, type NextRequest } from "next/server";
import { isPostgres } from "@/src/lib/db/dialect";
import { isLeader } from "@/src/lib/db/leader";
import { getHaRole, leaderLeaseValid, readHaStatus } from "@/ee/high-availability/role";
import { replicaRefusal } from "@/ee/high-availability/replica-admission";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Health check endpoint for Docker container health monitoring and load
 * balancers.
 *
 * Without high availability it always answers 200 {"status":"ok"}. In a
 * cluster (ee/docs/high-availability.md) it answers by role, so a load
 * balancer sends dashboard traffic to the leader only:
 *
 * - `GET /api/health`: 200 on the leader; 503 on a standby (and on a leader
 *   whose lease can no longer be vouched for).
 * - `GET /api/health?scope=request-path`: 200 on every node that can serve
 *   the request-path routes (the leader, and standbys with a copy of the
 *   database), for the backend Caddy's forward-auth and API gate calls use.
 * - `GET /api/health?scope=leader`: 200 only where the background jobs run:
 *   the leader of a cluster, the leader of PostgreSQL replicas, a standalone
 *   dashboard on SQLite.
 * - `GET /api/health?scope=live`: 200 while the process runs, whatever its
 *   role (container liveness checks).
 *
 * PostgreSQL replicas (ee/docs/high-availability.md#postgresql-replicas)
 * all serve the dashboard, the API and the request-path routes: 200 for
 * every scope but `leader`, unless the replica was refused (not admitted to
 * the cluster), which answers 503 for every scope but `live`.
 *
 * The answer names the role only; it is public.
 */
export async function GET(request: NextRequest) {
  const role = getHaRole();
  const scope = request.nextUrl.searchParams.get("scope");
  if (role === "standalone") {
    return isPostgres() ? replicaHealth(scope) : NextResponse.json({ status: "ok" }, { status: 200 });
  }
  if (scope === "live") {
    return NextResponse.json({ status: "ok", role }, { status: 200, headers: NO_STORE });
  }
  if (role === "leader") {
    return leaderLeaseValid()
      ? NextResponse.json({ status: "ok", role }, { status: 200, headers: NO_STORE })
      : NextResponse.json({ status: "fenced", role }, { status: 503, headers: NO_STORE });
  }
  if (scope === "request-path" && readHaStatus()?.copyReady === true) {
    return NextResponse.json({ status: "ok", role }, { status: 200, headers: NO_STORE });
  }
  return NextResponse.json({ status: "standby", role }, { status: 503, headers: NO_STORE });
}

/** A PostgreSQL replica: see the route comment. */
function replicaHealth(scope: string | null): NextResponse {
  if (scope === "live") return NextResponse.json({ status: "ok" }, { status: 200, headers: NO_STORE });
  if (replicaRefusal()) {
    return NextResponse.json({ status: "refused", role: "refused" }, { status: 503, headers: NO_STORE });
  }
  if (scope === "leader") {
    return isLeader()
      ? NextResponse.json({ status: "ok", role: "leader" }, { status: 200, headers: NO_STORE })
      : NextResponse.json({ status: "follower", role: "follower" }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ status: "ok" }, { status: 200, headers: NO_STORE });
}

// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { isPostgres } from "@/src/lib/db/dialect";
import { NO_STORE } from "@/ee/high-availability/http";
import { getPostgresReplicasView } from "@/ee/high-availability/replicas";

/**
 * The PostgreSQL replicas sharing the database
 * (ee/docs/high-availability.md#postgresql-replicas): which one answers,
 * which one leads the background jobs, every replica's heartbeat, version
 * and schema. Read-only. On SQLite `enabled` is false and the list is
 * empty.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "high_availability:read");
    if (!isPostgres()) {
      return NextResponse.json({ enabled: false, ...EMPTY }, { headers: NO_STORE });
    }
    return NextResponse.json({ enabled: true, ...(await getPostgresReplicasView()) }, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const EMPTY = {
  nodeId: null,
  role: null,
  refusal: null,
  leaderNodeId: null,
  election: null,
  liveReplicas: 0,
  nodes: [],
};

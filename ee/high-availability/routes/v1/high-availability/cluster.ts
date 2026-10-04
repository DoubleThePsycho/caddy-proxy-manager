// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { NO_STORE } from "@/ee/high-availability/http";
import { getClusterView } from "@/ee/high-availability/cluster/view";

/**
 * The dashboard cluster: this node's role, the lease holder and its fencing
 * epoch, replication and the last restore, the nodes, and the configuration
 * without secrets. Configured by environment variables only; reading never
 * needs a license.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "high_availability:read");
    return NextResponse.json(await getClusterView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

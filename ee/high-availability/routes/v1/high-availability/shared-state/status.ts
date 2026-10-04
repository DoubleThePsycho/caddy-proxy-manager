// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { NO_STORE } from "@/ee/high-availability/http";
import { sharedStateErrorResponse } from "@/ee/high-availability/shared-state/http";
import { getSharedStateStatus } from "@/ee/high-availability/shared-state/service";

/** What the shared state holds (sessions, consumers, credits not yet in the ledger) and the leader's last write-back. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "high_availability:read");
    return NextResponse.json(await getSharedStateStatus(), { headers: NO_STORE });
  } catch (error) {
    return sharedStateErrorResponse(error);
  }
}

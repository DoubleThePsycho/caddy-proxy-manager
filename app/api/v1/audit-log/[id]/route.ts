import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse, NotFoundError } from "@/src/lib/api-auth";
import { getAuditEventRecord } from "@/src/lib/models/audit";
import { auditEventConfigDiff } from "@/ee/config-history/versions";
import { parseRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string }> };

/**
 * One audit event with its data and, for a configuration change, the
 * before/after diff from the configuration history versions recorded with
 * it (secrets masked). Older events, and events recorded while history was
 * off, have none.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "audit_log:read");
    const { id: raw } = await params;
    const id = parseRowId(raw);
    if (id === null) throw new NotFoundError("Audit event not found");
    const event = await getAuditEventRecord(id);
    if (!event) throw new NotFoundError("Audit event not found");
    const { configBeforeId, configAfterId, ...rest } = event;
    const configDiff = await auditEventConfigDiff({ ...rest, configBeforeId, configAfterId });
    return NextResponse.json({ ...rest, configDiff }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

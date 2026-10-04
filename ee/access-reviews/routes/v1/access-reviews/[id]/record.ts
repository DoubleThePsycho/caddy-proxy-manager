// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiPermission } from "@/src/lib/api-auth";
import { buildRecord, readRecordFormat } from "@/ee/access-reviews/record";
import { parseRouteId } from "@/ee/access-reviews/http";

type Params = { params: Promise<{ id: string }> };

/** The campaign's record as a download: ?format=csv (default) or json. */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiPermission(request, "access_reviews:read");
    const id = parseRouteId((await params).id, "Access review not found");
    const record = await buildRecord(id, readRecordFormat(request.nextUrl.searchParams));
    return new NextResponse(record.body, {
      headers: {
        "Content-Type": record.contentType,
        "Content-Disposition": `attachment; filename="${record.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

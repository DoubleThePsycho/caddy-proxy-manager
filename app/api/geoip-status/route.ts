import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getGeoIpStatus } from "@/src/lib/geoip-status";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "proxy_hosts:read");
    return NextResponse.json(getGeoIpStatus());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

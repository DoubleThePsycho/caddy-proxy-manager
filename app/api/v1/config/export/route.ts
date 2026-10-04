import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { exportConfiguration } from "@/src/lib/config-transfer";

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "config:export");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    const passphrase = typeof body === "object" && body !== null ? (body as { passphrase?: unknown }).passphrase : undefined;
    const { filename, file } = await exportConfiguration(passphrase, userId);
    return new NextResponse(JSON.stringify(file, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

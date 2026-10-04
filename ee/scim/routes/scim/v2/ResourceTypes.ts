// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { handleScim } from "@/ee/scim/http";
import { listResponse, resourceTypes, scimJson } from "@/ee/scim/protocol";

export async function GET(request: NextRequest) {
  return handleScim(request, () => {
    const types = resourceTypes();
    return scimJson(listResponse(types, types.length, { startIndex: 1, count: types.length }));
  });
}

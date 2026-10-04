// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { handleScim } from "@/ee/scim/http";
import { listResponse, schemaDefinitions, scimJson } from "@/ee/scim/protocol";

export async function GET(request: NextRequest) {
  return handleScim(request, () => {
    const schemas = schemaDefinitions();
    return scimJson(listResponse(schemas, schemas.length, { startIndex: 1, count: schemas.length }));
  });
}

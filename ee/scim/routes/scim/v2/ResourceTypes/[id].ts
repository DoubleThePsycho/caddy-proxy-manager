// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { handleScim } from "@/ee/scim/http";
import { resourceTypes, ScimError, scimJson } from "@/ee/scim/protocol";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return handleScim(request, async () => {
    const { id } = await params;
    const type = resourceTypes().find((candidate) => candidate.id === id);
    if (!type) throw new ScimError(404, "Resource type not found");
    return scimJson(type);
  });
}

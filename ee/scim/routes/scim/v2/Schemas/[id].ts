// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { handleScim } from "@/ee/scim/http";
import { schemaDefinitions, ScimError, scimJson } from "@/ee/scim/protocol";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return handleScim(request, async () => {
    const { id } = await params;
    let wanted = id;
    try {
      wanted = decodeURIComponent(id);
    } catch {
      // Already decoded, or not valid percent-encoding: compare as it is.
    }
    const schema = schemaDefinitions().find((candidate) => candidate.id === wanted);
    if (!schema) throw new ScimError(404, "Schema not found");
    return scimJson(schema);
  });
}

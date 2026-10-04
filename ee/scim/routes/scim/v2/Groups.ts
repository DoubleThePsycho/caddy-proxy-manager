// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { handleScim, readScimBody } from "@/ee/scim/http";
import { resourceLocation, scimJson } from "@/ee/scim/protocol";
import { createScimGroup, listScimGroups } from "@/ee/scim/groups";

export async function GET(request: NextRequest) {
  return handleScim(request, async ({ params }) => scimJson(await listScimGroups(params)));
}

export async function POST(request: NextRequest) {
  return handleScim(request, async ({ token }) => {
    const resource = await createScimGroup(token, await readScimBody(request));
    return scimJson(resource, 201, { Location: resourceLocation("Groups", String(resource.id)) });
  });
}

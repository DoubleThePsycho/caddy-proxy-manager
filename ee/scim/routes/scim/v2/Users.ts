// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { handleScim, readScimBody } from "@/ee/scim/http";
import { resourceLocation, scimJson } from "@/ee/scim/protocol";
import { createScimUser, listScimUsers } from "@/ee/scim/users";

export async function GET(request: NextRequest) {
  return handleScim(request, async ({ params }) => scimJson(await listScimUsers(params)));
}

export async function POST(request: NextRequest) {
  return handleScim(request, async ({ token }) => {
    const { status, resource } = await createScimUser(token, await readScimBody(request));
    return scimJson(resource, status, { Location: resourceLocation("Users", String(resource.id)) });
  });
}

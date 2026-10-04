// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { handleScim, readScimBody } from "@/ee/scim/http";
import { scimJson, scimNoContent } from "@/ee/scim/protocol";
import { deleteScimGroup, getScimGroup, patchScimGroup, replaceScimGroup } from "@/ee/scim/groups";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return handleScim(request, async ({ params: query }) => scimJson(await getScimGroup((await params).id, query)));
}

export async function PUT(request: NextRequest, { params }: Params) {
  return handleScim(request, async ({ token }) =>
    scimJson(await replaceScimGroup(token, (await params).id, await readScimBody(request)))
  );
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return handleScim(request, async ({ token }) =>
    scimJson(await patchScimGroup(token, (await params).id, await readScimBody(request)))
  );
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return handleScim(request, async ({ token }) => {
    await deleteScimGroup(token, (await params).id);
    return scimNoContent();
  });
}

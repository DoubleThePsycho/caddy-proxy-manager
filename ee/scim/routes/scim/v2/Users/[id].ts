// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { handleScim, readScimBody } from "@/ee/scim/http";
import { scimJson, scimNoContent } from "@/ee/scim/protocol";
import { deleteScimUser, getScimUser, patchScimUser, replaceScimUser } from "@/ee/scim/users";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  return handleScim(request, async ({ params: query }) => scimJson(await getScimUser((await params).id, query)));
}

export async function PUT(request: NextRequest, { params }: Params) {
  return handleScim(request, async ({ token }) =>
    scimJson(await replaceScimUser(token, (await params).id, await readScimBody(request)))
  );
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return handleScim(request, async ({ token }) =>
    scimJson(await patchScimUser(token, (await params).id, await readScimBody(request)))
  );
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return handleScim(request, async ({ token }) => {
    await deleteScimUser(token, (await params).id);
    return scimNoContent();
  });
}

// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { handleScim } from "@/ee/scim/http";
import { scimJson, serviceProviderConfig } from "@/ee/scim/protocol";

export async function GET(request: NextRequest) {
  return handleScim(request, () => scimJson(serviceProviderConfig()));
}

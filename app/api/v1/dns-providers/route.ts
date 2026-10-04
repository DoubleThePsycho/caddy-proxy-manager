import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api-auth";
import { DNS_PROVIDERS } from "@/src/lib/dns-providers";

export async function GET(request: NextRequest) {
  try {
    // The catalogue of DNS providers, about no account: open to any token.
    await requireApiUser(request, { allowScopedToken: true });

    // Return provider definitions without any credential values
    const providers = DNS_PROVIDERS.map(({ name, displayName, description, docsUrl, fields, modulePath }) => ({
      name,
      displayName,
      description,
      docsUrl,
      modulePath,
      fields: fields.map(({ key, label, type, placeholder, description, required }) => ({
        key,
        label,
        type,
        placeholder,
        description,
        required,
      })),
    }));

    return NextResponse.json(providers);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

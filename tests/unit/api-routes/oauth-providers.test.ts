import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/lib/models/oauth-providers", () => ({
  listOAuthProviders: vi.fn(),
  createOAuthProvider: vi.fn(),
  getOAuthProvider: vi.fn(),
  updateOAuthProvider: vi.fn(),
  deleteOAuthProvider: vi.fn(),
}));

vi.mock("@/src/lib/api-auth", () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({
    userId: 1,
    role: "admin",
    authMethod: "bearer",
  }),
  apiErrorResponse: vi.fn((error: unknown) => {
    const { NextResponse } = require("next/server");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }),
}));

vi.mock("@/src/lib/models/audit", () => ({
  createAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/src/lib/auth-server", () => ({
  reloadOAuthProviders: vi.fn(async () => {}),
}));

import { GET as listGET, POST } from "@/app/api/v1/oauth-providers/route";
import { GET as itemGET, PUT } from "@/app/api/v1/oauth-providers/[id]/route";
import {
  createOAuthProvider,
  getOAuthProvider,
  listOAuthProviders,
  updateOAuthProvider,
} from "@/src/lib/models/oauth-providers";
import { toOAuthProviderView } from "@/src/lib/oauth-provider-view";

const SECRET_SENTINEL = "route-oauth-secret-sentinel";
const rawProvider = {
  id: "provider-id",
  name: "Example OIDC",
  type: "oidc",
  clientId: "public-client-id",
  clientSecret: SECRET_SENTINEL,
  issuer: "https://issuer.example.com",
  authorizationUrl: null,
  tokenUrl: null,
  userinfoUrl: null,
  scopes: "openid email profile",
  autoLink: false,
  enabled: true,
  source: "ui",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function request(method = "GET", body: unknown = {}): any {
  return {
    method,
    headers: { get: () => null },
    nextUrl: { pathname: "/api/v1/oauth-providers" },
    json: async () => body,
  };
}

async function expectSecretFree(response: Response) {
  const bodyText = await response.text();
  const data = JSON.parse(bodyText);

  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(data.hasClientSecret).toBe(true);
  expect(data.clientSecret).toBeUndefined();
  expect(bodyText).not.toContain(SECRET_SENTINEL);
  expect(bodyText).not.toContain("clientSecret");
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OAuth provider secret response boundaries", () => {
  it("keeps list responses secret-free", async () => {
    vi.mocked(listOAuthProviders).mockResolvedValue([toOAuthProviderView(rawProvider)]);

    const response = await listGET(request());
    const bodyText = await response.text();
    const data = JSON.parse(bodyText);

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(data[0].hasClientSecret).toBe(true);
    expect(data[0].clientSecret).toBeUndefined();
    expect(bodyText).not.toContain(SECRET_SENTINEL);
    expect(bodyText).not.toContain("clientSecret");
    expect(data[0].callbackUrl).toMatch(/\/api\/auth\/callback\/provider-id$/);
  });

  it("keeps create responses secret-free while accepting a new secret", async () => {
    vi.mocked(createOAuthProvider).mockResolvedValue(rawProvider);
    const body = {
      name: rawProvider.name,
      clientId: rawProvider.clientId,
      clientSecret: "submitted-new-secret",
    };

    const response = await POST(request("POST", body));

    await expectSecretFree(response);
    expect(createOAuthProvider).toHaveBeenCalledWith(expect.objectContaining({
      clientSecret: "submitted-new-secret",
    }));
  });

  it("keeps item responses secret-free", async () => {
    vi.mocked(getOAuthProvider).mockResolvedValue(rawProvider);

    const response = await itemGET(request(), {
      params: Promise.resolve({ id: rawProvider.id }),
    });

    const data = await expectSecretFree(response);
    expect(data.callbackUrl).toMatch(/\/api\/auth\/callback\/provider-id$/);
  });

  it("keeps update responses secret-free when rotating a secret", async () => {
    vi.mocked(getOAuthProvider).mockResolvedValue(rawProvider);
    vi.mocked(updateOAuthProvider).mockResolvedValue(rawProvider);

    const response = await PUT(request("PUT", { clientSecret: "replacement" }), {
      params: Promise.resolve({ id: rawProvider.id }),
    });

    await expectSecretFree(response);
    expect(updateOAuthProvider).toHaveBeenCalledWith(rawProvider.id, {
      clientSecret: "replacement",
    });
  });
});

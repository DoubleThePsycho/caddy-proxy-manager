import { describe, expect, it } from "vitest";
import {
  oauthCallbackUrl,
  toOAuthProviderView,
  withOAuthClientSecretRotation,
} from "@/src/lib/oauth-provider-view";

const SECRET_SENTINEL = "oauth-client-secret-sentinel";

const provider = {
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

describe("OAuth provider browser boundary", () => {
  it("uses Better Auth 1.7's standard, path-safe social callback URL", () => {
    expect(oauthCallbackUrl("https://ingressi.example.com/", "team/provider"))
      .toBe("https://ingressi.example.com/api/auth/callback/team%2Fprovider");
    expect(oauthCallbackUrl("https://ingressi.example.com", "provider-id"))
      .not.toContain("/oauth2/callback/");
  });

  it("uses an allowlisted view that cannot serialize existing or future secrets", () => {
    const view = toOAuthProviderView({
      ...provider,
      futureServerSecret: "future-secret-sentinel",
    } as typeof provider);
    const serialized = JSON.stringify(view);

    expect(view.hasClientSecret).toBe(true);
    expect(view.clientId).toBe("public-client-id");
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toContain("clientSecret");
    expect(serialized).not.toContain("future-secret-sentinel");
  });

  it("preserves the existing secret when an edit does not request rotation", () => {
    const update = withOAuthClientSecretRotation({ name: "Renamed" }, "   ");

    expect(update).toEqual({ name: "Renamed" });
    expect("clientSecret" in update).toBe(false);
  });

  it("includes a replacement only for an explicit non-empty rotation", () => {
    const update = withOAuthClientSecretRotation(
      { name: "Renamed" },
      "  replacement-client-secret  "
    );

    expect(update).toEqual({
      name: "Renamed",
      clientSecret: "replacement-client-secret",
    });
  });
});

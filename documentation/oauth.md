# OAuth and OpenID Connect sign-in

Supports any OIDC-compliant provider (Authentik, Keycloak, Auth0, etc.). Providers can be configured via environment variables or the **Settings → OAuth providers** UI. The `OAUTH_*` and `AUTH_*` variables are listed in the [configuration reference](configuration.md#environment-variables). The **Sign-in and directories** page shows each provider next to the other sign-in sources ([sign-in-and-directories.md](sign-in-and-directories.md)).

## Option A: Configure via the UI (recommended)

1. Log in as admin and navigate to **Settings → OAuth providers**
2. Click **Add Provider** and fill in the details
3. Copy the displayed **Callback URL** and add it to your OAuth provider's allowed redirect URIs

## Option B: Configure via environment variables

```bash
# Set your public URL (REQUIRED for OAuth to work)
BASE_URL=https://caddy-manager.example.com

OAUTH_ENABLED=true
OAUTH_PROVIDER_NAME="Authentik"  # Display name
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
OAUTH_ISSUER=https://auth.example.com/application/o/app/
```

## Redirect URI

The callback URL format is:
```
{BASE_URL}/api/auth/callback/{provider-id}
```

For environment-configured providers, the provider ID is derived from `OAUTH_PROVIDER_NAME` (lowercased, non-alphanumeric replaced with `-`). The exact callback URL is shown in **Settings → OAuth providers** after the provider is synced.

Examples:
- `https://caddy-manager.example.com/api/auth/callback/authentik` (production, `OAUTH_PROVIDER_NAME=Authentik`)
- `http://localhost:3000/api/auth/callback/authentik` (development)

The `BASE_URL` environment variable must match exactly where users access your dashboard.

> **Upgrading from < 1.0-RC:** The old callback URL (`/api/auth/callback/oauth2`) no longer works. Update your OAuth provider's redirect URI to the new format shown in **Settings → OAuth providers**.

OAuth login appears on the login page alongside credentials.

## Account linking

Attaching an OAuth identity to an existing Ingressi user requires **Auto-link accounts** to be enabled for that provider (**Settings → OAuth providers**, or `OAUTH_ALLOW_AUTO_LINKING=true` for environment-configured providers). The switch marks the provider as trusted to prove that its identity owns the Ingressi account carrying the same email address, so leave it off for any IdP where users can register an arbitrary email themselves.

With it enabled:

- Signing in through the provider links the identity to the existing user with the matching email.
- **Profile → OAuth Connections** can link the provider to the signed-in account. The provider's email must match the signed-in user's email.

With it disabled, both paths are refused and the provider redirects to `/api/auth/error?error=account_not_linked`.

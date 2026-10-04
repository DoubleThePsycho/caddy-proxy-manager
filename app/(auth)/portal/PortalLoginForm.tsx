"use client";

import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { Shield } from "lucide-react";
import { authClient } from "@/src/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import { BrandFooter, BrandLogo, hasLogo } from "@/ee/white-label/ui/BrandParts";

interface PortalLoginFormProps {
  rid: string;
  hasRedirect: boolean;
  targetDomain: string;
  /** Why this sign-in cannot proceed; replaces the login form when set. */
  errorMessage?: string | null;
  enabledProviders?: Array<{ id: string; name: string }>;
  existingSession?: { userId: string; name: string | null; email: string | null } | null;
}

/**
 * The page around every state of the portal. People signing in to a
 * protected site see this page most, so it carries the white-label logo (or
 * name), footer text, support contact and "Powered by" note.
 */
function PortalShell({ children }: { children: ReactNode }) {
  const branding = useBranding();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background px-4 py-8">
      {hasLogo(branding) ? (
        <BrandLogo branding={branding} className="max-h-12 w-auto max-w-[220px]" />
      ) : (
        <p className="text-lg font-semibold tracking-tight break-words text-center">{branding.loginHeading}</p>
      )}
      {children}
      <BrandFooter branding={branding} className="w-full max-w-sm" />
    </div>
  );
}

export default function PortalLoginForm({
  rid,
  hasRedirect,
  targetDomain,
  errorMessage = null,
  enabledProviders = [],
  existingSession,
}: PortalLoginFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [oauthPending, setOauthPending] = useState<string | null>(null);

  // If user already has a NextAuth session (e.g. from OAuth), auto-create forward auth session
  useEffect(() => {
    if (existingSession && rid) {
      setPending(true);
      fetch("/api/forward-auth/session-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rid }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.redirectTo) {
            window.location.href = data.redirectTo;
          } else {
            setError(data.error ?? "Failed to authorize access.");
            setPending(false);
          }
        })
        .catch(() => {
          setError("An unexpected error occurred.");
          setPending(false);
        });
    }
  }, [existingSession, rid]);

  const handleCredentialSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const username = String(formData.get("username") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    if (!username || !password) {
      setError("Username and password are required.");
      setPending(false);
      return;
    }

    try {
      const response = await fetch("/api/forward-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, rid }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? "Login failed.");
        setPending(false);
        return;
      }

      window.location.href = data.redirectTo;
    } catch {
      setError("An unexpected error occurred. Please try again.");
      setPending(false);
    }
  };

  const handleOAuthSignIn = (providerId: string) => {
    setError(null);
    setOauthPending(providerId);
    // Redirect back to this portal page after OAuth, with the rid param preserved.
    // The rid is an opaque server-side ID — the actual redirect URI is never in the URL.
    const callbackUrl = `/portal?rid=${encodeURIComponent(rid)}`;
    authClient.signIn.social({ provider: providerId, callbackURL: callbackUrl });
  };

  const disabled = pending || !!oauthPending;

  if (!hasRedirect) {
    return (
      <PortalShell>
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center space-y-1">
            <CardTitle className="text-xl">Authentication Required</CardTitle>
            <CardDescription>No redirect destination specified.</CardDescription>
          </CardHeader>
        </Card>
      </PortalShell>
    );
  }

  if (errorMessage) {
    return (
      <PortalShell>
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center space-y-1">
            <div className="flex justify-center mb-2">
              <Shield className="h-8 w-8 text-muted-foreground" />
            </div>
            <CardTitle className="text-xl">Authentication Required</CardTitle>
            {targetDomain && (
              <CardDescription>
                Sign in to access <span className="font-medium text-foreground">{targetDomain}</span>
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </PortalShell>
    );
  }

  // If we have a session and are auto-redirecting, show a loading state
  if (existingSession && pending && !error) {
    return (
      <PortalShell>
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center space-y-1">
            <div className="flex justify-center mb-2">
              <Shield className="h-8 w-8 text-muted-foreground" />
            </div>
            <CardTitle className="text-xl">Authorizing...</CardTitle>
            <CardDescription>
              Signing in as {existingSession.name ?? existingSession.email}
            </CardDescription>
          </CardHeader>
        </Card>
      </PortalShell>
    );
  }

  return (
    <PortalShell>
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center space-y-1">
          <div className="flex justify-center mb-2">
            <Shield className="h-8 w-8 text-muted-foreground" />
          </div>
          <CardTitle className="text-xl">Authentication Required</CardTitle>
          <CardDescription>
            {targetDomain
              ? <>Sign in to access <span className="font-medium text-foreground">{targetDomain}</span></>
              : "Sign in to continue"
            }
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {enabledProviders.length > 0 && (
            <>
              <div className="space-y-2">
                {enabledProviders.map((provider) => {
                  const isPending = oauthPending === provider.id;
                  return (
                    <Button
                      key={provider.id}
                      variant="outline"
                      className="w-full"
                      onClick={() => handleOAuthSignIn(provider.id)}
                      disabled={disabled}
                    >
                      {isPending ? (
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent mr-2" />
                      ) : null}
                      Sign in with {provider.name}
                    </Button>
                  );
                })}
              </div>
              <div className="relative">
                <Separator />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                  or
                </span>
              </div>
            </>
          )}

          <form onSubmit={handleCredentialSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                autoFocus={enabledProviders.length === 0}
                disabled={disabled}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                disabled={disabled}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={disabled}>
              {pending ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </PortalShell>
  );
}

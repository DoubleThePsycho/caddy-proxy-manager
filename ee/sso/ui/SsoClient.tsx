// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchField } from "@/components/ui/SearchField";
import { SectionCard } from "@/components/ui/SectionCard";
import { Switch } from "@/components/ui/switch";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import type { BreakGlassCandidate, SsoEnforcementView } from "@/ee/sso/enforcement";

/** More break-glass candidates than this get a search box. */
const CANDIDATE_SEARCH_FROM = 10;

type SaveResult = { ok: true; view: SsoEnforcementView } | { ok: false; error: string };

type Props = {
  enforcement: SsoEnforcementView;
  candidates: BreakGlassCandidate[];
  saveEnforcement: (input: { enabled: boolean; breakGlassUsernames: string[] }) => Promise<SaveResult>;
  /** Settings is readable (OAuth providers are set up there). Default true. */
  canReadSettings?: boolean;
};

function selectableUsernames(view: SsoEnforcementView): Set<string> {
  return new Set(
    view.breakGlassAccounts
      .filter((account) => account.passwordSignIn && account.username)
      .map((account) => account.username as string)
  );
}

export default function SsoClient({ enforcement, candidates, saveEnforcement, canReadSettings = true }: Props) {
  const router = useRouter();
  const { productName } = useBranding();
  const [view, setView] = useState(enforcement);
  const [enabled, setEnabled] = useState(enforcement.enabled);
  const [selected, setSelected] = useState(() => selectableUsernames(enforcement));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const readOnly = !view.configurable;
  const needle = query.trim().toLowerCase();
  const shownCandidates = needle
    ? candidates.filter((candidate) => `${candidate.username} ${candidate.name ?? ""}`.toLowerCase().includes(needle))
    : candidates;

  const dirty = useMemo(() => {
    const current = selectableUsernames(view);
    return enabled !== view.enabled || current.size !== selected.size || [...selected].some((name) => !current.has(name));
  }, [enabled, selected, view]);

  function toggle(username: string, checked: boolean) {
    setSaved(false);
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(username);
      else next.delete(username);
      return next;
    });
  }

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveEnforcement({ enabled, breakGlassUsernames: [...selected] });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setView(result.view);
      setEnabled(result.view.enabled);
      setSelected(selectableUsernames(result.view));
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Identity", { label: "Sign-in and directories", href: "/sign-in" }, "Single sign-on"]}
        title="Single sign-on"
        description={`Require sign-in to ${productName} through your identity provider. The forward-auth portal is not affected.`}
      />

      {readOnly && (
        <Banner tone="info" title="Read-only without a license.">
          Changing enforced SSO needs a Business license or higher. You can still turn it off.{" "}
          <Link href="/license" className="text-brand underline-offset-4 hover:underline">Manage the license</Link>
        </Banner>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title={
            <span className="flex flex-wrap items-center gap-2">
              Enforced SSO
              <Badge variant={view.enabled ? "success" : "secondary"}>{view.enabled ? "On" : "Off"}</Badge>
            </span>
          }
          description="Password sign-in is refused for every account except the break-glass accounts, and nobody can register with a password."
          padded
          contentClassName="flex flex-col gap-5"
        >
          {view.warnings.length > 0 && (
            <Banner tone="warn" layout="stacked" title="Check this setting">
              <ul className="m-0 list-disc space-y-1 pl-4">
                {view.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </Banner>
          )}

          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="sso-enforce" className="flex flex-col items-start gap-1">
              <span>Require single sign-on for dashboard sign-in</span>
              <span className="text-xs font-normal text-muted-foreground">
                Turning it on needs an enabled OAuth/OIDC or SAML provider and at least one break-glass administrator.
              </span>
            </Label>
            <Switch
              id="sso-enforce"
              checked={enabled}
              onCheckedChange={(checked) => { setEnabled(checked); setSaved(false); }}
              disabled={(readOnly && !(view.enabled && enabled)) || pending}
            />
          </div>

          <div className="flex flex-col gap-2">
            <p className="m-0 text-sm font-medium">Break-glass accounts</p>
            <p className="m-0 text-xs text-muted-foreground">
              These accounts can still sign in with their username and password, for example while the identity provider is down.
              Keep at least one active administrator here and store its password safely.
            </p>
            {candidates.length > CANDIDATE_SEARCH_FROM && (
              <SearchField
                aria-label="Find an account"
                placeholder="Find an account"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full max-w-sm"
              />
            )}
            {candidates.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">No account can sign in with a password.</p>
            ) : shownCandidates.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">No account matches.</p>
            ) : (
              <div className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line">
                {shownCandidates.map((candidate) => {
                  const id = `break-glass-${candidate.id}`;
                  return (
                    <div key={candidate.id} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        id={id}
                        checked={selected.has(candidate.username)}
                        onCheckedChange={(checked) => toggle(candidate.username, checked === true)}
                        disabled={readOnly || pending}
                      />
                      <Label htmlFor={id} className="flex flex-1 flex-wrap items-center gap-2 font-normal">
                        <span className="num font-medium">{candidate.username}</span>
                        {candidate.name && <span className="text-muted-foreground">{candidate.name}</span>}
                      </Label>
                      <Badge variant={candidate.role === "admin" ? "info" : "outline"}>{candidate.role}</Badge>
                      {candidate.status !== "active" && <Badge variant="warning">{candidate.status}</Badge>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {error && <Banner tone="bad" live>{error}</Banner>}
          {saved && !error && <Banner tone="ok" live>Saved.</Banner>}

          {(!readOnly || (view.enabled && !enabled)) && (
            <div>
              <Button onClick={save} disabled={pending || !dirty}>
                {pending ? "Saving…" : readOnly ? "Turn off" : "Save"}
              </Button>
            </div>
          )}
        </SectionCard>

        <div className="flex min-w-0 flex-col gap-5">
          <SectionCard
            title="Identity providers"
            padded
            contentClassName="flex flex-col gap-3"
          >
            {view.ssoProviders.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">No provider is enabled.</p>
            ) : (
              <ul className="m-0 list-none space-y-1.5 p-0 text-sm">
                {view.ssoProviders.map((provider) => (
                  <li key={provider.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{provider.name}</span>
                    <Badge variant="outline">{provider.kind === "saml" ? "SAML" : "OIDC"}</Badge>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              {canReadSettings && (
                <Button variant="outline" size="sm" asChild>
                  <Link href="/oauth-providers">Manage OAuth providers</Link>
                </Button>
              )}
              <Button variant="outline" size="sm" asChild>
                <Link href="/saml">Manage SAML providers</Link>
              </Button>
            </div>
          </SectionCard>

          <SectionCard title="If the identity provider is down" padded contentClassName="flex flex-col gap-2 text-sm text-muted-foreground">
            <p className="m-0">
              Open the login page, choose <span className="font-medium text-foreground">Sign in with a password</span> and sign in
              with a break-glass account.
            </p>
            <p className="m-0">
              Without a working break-glass password, an operator with shell access can turn enforcement off as described in the
              enforced SSO documentation.
            </p>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { ChevronDown, KeyRound, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import {
  ConfigureLink,
  enabledStatus,
  Fact,
  LastSignInFact,
  plural,
  SourceCard,
  Sub,
  UsersFact,
  type Formatters,
} from "@/src/components/sign-in/source-card";
import type { OidcSourceView, SignInOverview } from "@/src/lib/sign-in-overview";
import { cn } from "@/lib/utils";
import { EnforcementSection } from "@/ee/sso/ui/EnforcementSection";
import { SamlSourceCard } from "@/ee/saml/ui/SamlSourceCard";
import { LdapSourceCard } from "@/ee/ldap/ui/LdapSourceCard";
import { ScimSourceCard } from "@/ee/scim/ui/ScimSourceCard";

type Can = {
  writeSso: boolean;
  writeLdap: boolean;
  readSettings: boolean;
  readUsers: boolean;
  readAuditLog: boolean;
  readScim: boolean;
  readLdap: boolean;
};

type Props = {
  overview: SignInOverview;
  can: Can;
  /** saveSsoEnforcementAction (ee/sso/ui/actions.ts); turning enforcement off never needs a license. */
  turnOffEnforcement: (input: { enabled: boolean }) => Promise<{ ok: true } | { ok: false; error: string }>;
};

function OidcCard({ provider, overview, can, format }: { provider: OidcSourceView; overview: SignInOverview; can: Can; format: Formatters }) {
  return (
    <SourceCard
      icon={KeyRound}
      title={provider.name}
      subtitle={provider.type === "oidc" ? "OpenID Connect provider" : "OAuth provider"}
      status={enabledStatus(provider.enabled)}
      footerNote={<>Scopes <span className="num">{provider.scopes}</span></>}
      footerActions={can.readSettings ? <ConfigureLink href="/oauth-providers" name={provider.name} /> : undefined}
    >
      <LastSignInFact signIn={provider.lastSignIn} format={format} />
      <UsersFact users={provider.users} />
      <Fact label="Group-to-role mappings">
        <span>None</span>
        <Sub>
          {overview.oauthRoleFromClaims
            ? "A new account may take its role from the provider's claims"
            : "Role claims are off; roles are set on the Users page"}
        </Sub>
      </Fact>
      <Fact label="Accounts">
        <span>{provider.autoLink ? "Auto-link on" : "Auto-link off"}</span>
        <Sub>
          {provider.autoLink
            ? "Links an existing account with the same e-mail"
            : overview.oauthRegistration
              ? "New accounts are created at first sign-in"
              : "No sign-up through this provider"}
        </Sub>
      </Fact>
      {(provider.issuer || provider.host) && (
        <Fact label="Issuer" wide>
          <span className="num break-all">{provider.issuer ?? provider.host}</span>
        </Fact>
      )}
    </SourceCard>
  );
}

/** Sign-in and directories: enforced SSO, the login page, and every place people sign in from. */
export default function SignInClient({ overview, can, turnOffEnforcement }: Props) {
  const format = useFormat();
  const enforcement = overview.enforcement;
  const ldap = overview.ldap ?? [];
  // SCIM counts as a source once it is set up: on, or with a token or users.
  const showScim = overview.scim !== null && (overview.scim.enabled || overview.scim.tokens.count > 0 || overview.scim.users.total > 0);
  const sources = overview.oidc.length + overview.saml.length + ldap.length + (showScim ? 1 : 0);
  const failing = ldap.filter((directory) => directory.enabled && directory.health?.status === "failing").length;

  const addItems: { label: string; href: string }[] = [];
  if (can.readSettings && can.writeSso) addItems.push({ label: "OpenID Connect or OAuth provider", href: "/oauth-providers" });
  if (can.writeSso) addItems.push({ label: "SAML provider", href: "/saml" });
  if (can.writeLdap) addItems.push({ label: "LDAP directory", href: "/ldap" });
  if (can.readScim) addItems.push({ label: "SCIM provisioning", href: "/scim" });

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Identity", "Sign-in and directories"]}
        title="Sign-in and directories"
        actions={
          <>
            {can.readUsers && (
              <Button asChild variant="outline">
                <Link href="/users">Users and groups</Link>
              </Button>
            )}
            {addItems.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button>
                    <Plus />
                    Add a provider or directory
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {addItems.map((item) => (
                    <DropdownMenuItem key={item.href} asChild>
                      <Link href={item.href}>{item.label}</Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      <EnforcementSection
        enforcement={enforcement}
        canWriteSso={can.writeSso}
        canReadAuditLog={can.readAuditLog}
        turnOffEnforcement={turnOffEnforcement}
        loginOptions={
          <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-2">
            <span className="text-xs text-soft">What the login page offers now</span>
            <ul aria-label="Login page options" className="m-0 flex list-none flex-col gap-2 rounded-xl border border-line bg-background p-3.5">
              {overview.loginPage.map((option, index) =>
                option.state === "break_glass" ? (
                  <li key={`${option.kind}-${index}`} className="flex justify-center pt-0.5 text-xs text-soft">
                    {option.label}{option.kind === "passkey" ? " (break-glass accounts)" : ""}
                  </li>
                ) : (
                  <li
                    key={`${option.kind}-${index}`}
                    className={cn(
                      "flex min-h-[34px] items-center justify-center gap-2 rounded-lg px-3 text-center text-[13px]",
                      option.state === "unavailable"
                        ? "border border-dashed border-line2 text-muted-foreground"
                        : "border border-line2 bg-panel"
                    )}
                  >
                    {option.label}
                    {option.state === "unavailable" && (
                      <span className="rounded-full bg-bad-tint px-1.5 text-[11px] leading-[18px] font-semibold text-bad">unavailable</span>
                    )}
                  </li>
                )
              )}
            </ul>
          </div>
        }
      />

      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h2 className="m-0 text-base leading-6 font-semibold">Where people sign in from</h2>
        <span className="text-[13px] text-soft">
          {plural(sources, "source")}
          {failing > 0 ? ` · ${failing} failing` : ""}
        </span>
      </div>

      {sources === 0 ? (
        <section aria-label="Sign-in sources" className="rounded-2xl border border-line bg-panel">
          <EmptyState
            icon={KeyRound}
            title="Only local accounts so far"
            action={addItems[0] ? (
              <Button asChild>
                <Link href={addItems[0].href}>Add {addItems[0].label.toLowerCase()}</Link>
              </Button>
            ) : undefined}
          />
        </section>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(440px,100%),1fr))] items-start gap-4">
          {overview.oidc.map((provider) => (
            <OidcCard key={provider.id} provider={provider} overview={overview} can={can} format={format} />
          ))}
          {overview.saml.map((provider) => (
            <SamlSourceCard key={provider.id} provider={provider} format={format} />
          ))}
          {ldap.map((directory) => (
            <LdapSourceCard key={directory.id} directory={directory} can={can} format={format} />
          ))}
          {showScim && overview.scim && <ScimSourceCard scim={overview.scim} format={format} />}
        </div>
      )}

      {(overview.ldap === null || overview.scim === null) && (
        <p className="m-0 text-xs text-soft">
          {overview.ldap === null && overview.scim === null
            ? "LDAP directories and SCIM provisioning are not shown: your role cannot read them."
            : overview.ldap === null
              ? "LDAP directories are not shown: your role cannot read them."
              : "SCIM provisioning is not shown: your role cannot read it."}
        </p>
      )}
    </div>
  );
}

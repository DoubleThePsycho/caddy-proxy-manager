// SPDX-License-Identifier: Elastic-2.0
"use client";

import { IdCard } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { ConfigureLink, enabledStatus, Fact, LastSignInFact, MappingsFact, plural, SourceCard, Sub, UsersFact, type Formatters } from "@/src/components/sign-in/source-card";
import type { SamlSourceView } from "@/src/lib/sign-in-overview";
import { cn } from "@/lib/utils";

/** A SAML identity provider on the Sign-in and directories page. */
export function SamlSourceCard({ provider, format }: { provider: SamlSourceView; format: Formatters }) {
  const certificate = provider.certificate;
  return (
    <SourceCard
      icon={IdCard}
      title={provider.name}
      subtitle="SAML 2.0 identity provider"
      status={enabledStatus(provider.enabled)}
      alert={provider.warnings.length > 0 ? (
        <Banner tone="warn" layout="stacked" title="Worth a second look">
          <ul className="m-0 list-disc pl-4">
            {provider.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </Banner>
      ) : undefined}
      footerActions={<ConfigureLink href="/saml" name={provider.name} />}
    >
      <LastSignInFact signIn={provider.lastSignIn} format={format} />
      <UsersFact users={provider.users} />
      <MappingsFact mappings={provider.mappings} defaultRole={provider.defaultRole} none="Roles are set on the Users page" />
      <Fact label="Who may sign in">
        <span>{provider.requiredGroup ? <>Group <span className="num">{provider.requiredGroup}</span></> : "Anyone the provider sends"}</span>
        <Sub>
          {provider.provisionUsers
            ? "Accounts are created at first sign-in"
            : provider.linkExistingAccounts
              ? "Links an existing account by e-mail"
              : "Existing links only"}
        </Sub>
      </Fact>
      <Fact label="Account id">
        <span className="num break-all">{provider.subjectAttribute ?? "NameID (persistent)"}</span>
      </Fact>
      <Fact label="IdP signing certificate">
        {certificate ? (
          <>
            <span className={cn(certificate.expired && "font-semibold text-bad")}>
              {certificate.expired ? "Expired" : "Expires"} <span className="num">{format.date(certificate.notAfter)}</span>
            </span>
            {certificate.count > 1 && <Sub>{plural(certificate.count, "certificate")}; the first to expire is shown</Sub>}
          </>
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </Fact>
    </SourceCard>
  );
}

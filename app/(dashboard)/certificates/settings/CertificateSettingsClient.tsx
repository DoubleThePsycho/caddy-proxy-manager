"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { AcmeSettings, DnsSettings, GeneralSettings } from "@/lib/settings";
import type { DnsProviderApiStatus, DnsProviderDefinition } from "@/src/lib/dns-providers";
import CertificateStorageSection from "@/ee/high-availability/ui/CertificateStorageSection";
import type { CertificateStorageView } from "@/ee/high-availability/types";
import {
  removeCertificateStorageAction,
  saveCertificateStorageAction,
  testCertificateStorageAction,
} from "@/ee/high-availability/ui/certificate-storage-actions";
import {
  ChoiceField,
  OverrideRow,
  SettingRow,
  SettingRows,
  SettingsForm,
  SettingsGroupForms,
  ToggleField,
  type ActionResult,
} from "@/src/components/settings/settings-form";
import { RestrictedNotice } from "@/src/components/settings/RestrictedNotice";
import { updateAcmeSettingsAction, updateDnsProviderSettingsAction, updateDnsSettingsAction, updateGeneralSettingsAction } from "../../settings/actions";
import { useUnsavedWarning } from "../../settings/use-unsaved-warning";

type Issuer = "le" | "custom";

export type CertificateSettingsProps = {
  acme: AcmeSettings | null;
  general: GeneralSettings | null;
  dnsProvider: DnsProviderApiStatus | null;
  dnsProviderDefinitions: DnsProviderDefinition[];
  dns: DnsSettings | null;
  isSlave: boolean;
  /** On a replica: the settings it overrides instead of following its master. */
  overrides: { general: boolean; acme: boolean; dnsProvider: boolean; dns: boolean };
  /** Certificate storage (ee/high-availability); null without high_availability:read. */
  certificateStorage: { view: CertificateStorageView; canWrite: boolean } | null;
  /** settings:write */
  canSave: boolean;
  /** certificates:read, for the breadcrumb's link. */
  canOpenCertificates: boolean;
};

/** Certificate settings: the ACME issuer and contact, DNS-01 providers and resolvers, and where Caddy keeps certificates. */
export default function CertificateSettingsClient({
  acme,
  general,
  dnsProvider,
  dnsProviderDefinitions,
  dns,
  isSlave,
  overrides,
  certificateStorage,
  canSave,
  canOpenCertificates,
}: CertificateSettingsProps) {
  const onDirtyChange = useUnsavedWarning();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Traffic", canOpenCertificates ? { label: "Certificates", href: "/certificates" } : "Certificates", "Settings"]}
        title="Certificate settings"
      />
      <SettingsGroupForms
        name="Certificate settings"
        canSave={canSave}
        onDirtyChange={onDirtyChange}
        after={
          <div id="certificate-storage" className="flex scroll-mt-20 md:scroll-mt-4 flex-col gap-4">
            {certificateStorage ? (
              <CertificateStorageSection
                view={certificateStorage.view}
                canWrite={certificateStorage.canWrite}
                save={saveCertificateStorageAction}
                remove={removeCertificateStorageAction}
                test={testCertificateStorageAction}
              />
            ) : (
              <SectionCard title="Certificate storage" headingLevel={2} padded>
                <RestrictedNotice permission="high_availability:read" />
              </SectionCard>
            )}
          </div>
        }
      >
        <AuthorityCard acme={acme} general={general} isSlave={isSlave} overrides={overrides} />
        <DnsProvidersCard
          dnsProvider={dnsProvider}
          dnsProviderDefinitions={dnsProviderDefinitions}
          isSlave={isSlave}
          override={overrides.dnsProvider}
          canWrite={canSave}
        />
        <DnsResolversCard dns={dns} isSlave={isSlave} override={overrides.dns} />
      </SettingsGroupForms>
    </div>
  );
}

function AuthorityCard({
  acme,
  general,
  isSlave,
  overrides,
}: {
  acme: AcmeSettings | null;
  general: GeneralSettings | null;
  isSlave: boolean;
  overrides: { general: boolean; acme: boolean };
}) {
  const [override, setOverride] = useState(overrides.acme);
  const [issuer, setIssuer] = useState<Issuer>(acme?.caUrl ? "custom" : "le");
  const disabled = isSlave && !override;
  // The contact e-mail is a general setting; on a replica it follows the override saved under Settings, General.
  const contactDisabled = isSlave && !overrides.general;
  return (
    <SectionCard id="acme" className="scroll-mt-20 md:scroll-mt-4" title="Certificate authority" headingLevel={2} divided={false}>
      <SettingsForm action={updateAcmeSettingsAction} order={0}>
        <SettingRows>
          {isSlave && <OverrideRow id="acme-override" checked={override} onCheckedChange={setOverride} />}
          <SettingRow label="Issuer" labelId="settings-acme-issuer">
            <ChoiceField
              name="issuer"
              label="Issuer"
              value={issuer}
              onChange={setIssuer}
              disabled={disabled}
              options={[
                { value: "le", label: "Let's Encrypt" },
                { value: "custom", label: "Custom ACME directory" },
              ]}
            />
          </SettingRow>
          {issuer === "custom" ? (
            <>
              <SettingRow label="ACME directory URL" htmlFor="settings-acme-url" hint="HTTPS only.">
                <Input
                  id="settings-acme-url"
                  name="caUrl"
                  type="url"
                  placeholder="https://ca.internal.example.com/acme/acme/directory"
                  defaultValue={acme?.caUrl ?? ""}
                  disabled={disabled}
                  className="num"
                />
              </SettingRow>
              <SettingRow
                label="CA root certificate"
                htmlFor="settings-acme-root"
                hint="Only if the CA's own TLS certificate is not publicly trusted. PEM."
              >
                <Textarea
                  id="settings-acme-root"
                  name="caRootPem"
                  placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                  defaultValue={acme?.caRootPem ?? ""}
                  disabled={disabled}
                  rows={3}
                  className="num min-h-0 text-xs"
                />
              </SettingRow>
            </>
          ) : (
            <>
              <input type="hidden" name="caUrl" value="" />
              <input type="hidden" name="caRootPem" value="" />
            </>
          )}
        </SettingRows>
      </SettingsForm>
      <SettingsForm action={updateGeneralSettingsAction} order={1}>
        <SettingRows>
          <SettingRow
            label="Contact e-mail"
            htmlFor="settings-acme-email"
            hint="The CA sends expiry notices here."
            note={contactDisabled ? "Follows the master unless Settings, General overrides it on this replica." : undefined}
          >
            <Input
              id="settings-acme-email"
              name="acmeEmail"
              type="email"
              defaultValue={general?.acmeEmail ?? ""}
              disabled={contactDisabled}
              className="w-[320px] max-w-full"
            />
          </SettingRow>
          {/* Saved with the e-mail: the primary domain (edited under Settings) and, on a replica, its override. */}
          <input type="hidden" name="primaryDomain" value={general?.primaryDomain ?? "ingressi.localhost"} data-untracked="" />
          {isSlave && <input type="hidden" name="overrideEnabled" value={overrides.general ? "on" : ""} data-untracked="" />}
        </SettingRows>
      </SettingsForm>
    </SectionCard>
  );
}

function DnsProvidersCard({
  dnsProvider,
  dnsProviderDefinitions,
  isSlave,
  override: initialOverride,
  canWrite,
}: {
  dnsProvider: DnsProviderApiStatus | null;
  dnsProviderDefinitions: DnsProviderDefinition[];
  isSlave: boolean;
  override: boolean;
  canWrite: boolean;
}) {
  const [override, setOverride] = useState(initialOverride);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const configured = dnsProvider?.providers ? Object.keys(dnsProvider.providers) : [];
  const disabled = !canWrite || pending || (isSlave && !override);

  function run(fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    if (isSlave) data.set("overrideEnabled", override ? "on" : "");
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await updateDnsProviderSettingsAction(null, data));
      } catch (error) {
        setResult({ success: false, message: error instanceof Error ? error.message : "Could not save the DNS provider" });
      }
    });
  }

  function credentialSummary(name: string): string {
    const definition = dnsProviderDefinitions.find((provider) => provider.name === name);
    const fields = dnsProvider?.providers[name]?.configuredFields ?? [];
    const labels = fields.map((key) => definition?.fields.find((field) => field.key === key)?.label ?? key);
    return labels.length === 0 ? "No credentials" : labels.join(", ");
  }

  const addButton = (
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setEditing("")}>
      <Plus /> Add provider
    </Button>
  );

  return (
    <SectionCard
      id="dns-providers"
      className="scroll-mt-20 md:scroll-mt-4"
      title="DNS-01 providers"
      count={configured.length > 0 ? configured.length : undefined}
      headingLevel={2}
      actions={configured.length > 0 ? addButton : undefined}
      divided={false}
    >
      {isSlave && (
        <SettingRows>
          <SettingRow label="Master settings" hint="A replica follows its master unless this is on.">
            <ToggleField
              id="dnsprovider-override"
              label="Override the master's DNS providers on this replica"
              checked={override}
              onCheckedChange={setOverride}
            />
          </SettingRow>
        </SettingRows>
      )}
      {result?.message && (
        <div className="px-5 pb-3">
          <Banner tone={result.success ? "ok" : "bad"} live>
            {result.message}
          </Banner>
        </div>
      )}
      {configured.length === 0 ? (
        <div className="border-t border-line">
          <EmptyState
            compact
            headingLevel={3}
            title="No DNS provider yet"
            description="Wildcard certificates and hosts not reachable from the Internet need one."
            action={addButton}
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-xs text-soft">
                  <th scope="col" className="border-y border-line px-5 py-2 font-medium">Provider</th>
                  <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">Credentials</th>
                  <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">Used for</th>
                  <th scope="col" className="border-y border-line py-2 pl-2.5 pr-5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {configured.map((name) => {
                  const definition = dnsProviderDefinitions.find((provider) => provider.name === name);
                  const label = definition?.displayName ?? name;
                  const isDefault = dnsProvider?.default === name;
                  return (
                    <tr key={name} className="border-b border-line last:border-b-0 hover:bg-panel2">
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2">
                          <span className="font-semibold">{label}</span>
                          {isDefault && <Badge variant="success">Default</Badge>}
                        </span>
                      </td>
                      <td className="px-2.5 py-3 text-muted-foreground">{credentialSummary(name)}</td>
                      <td className="px-2.5 py-3 text-muted-foreground">
                        {isDefault ? "Every DNS-01 certificate that does not pick another" : "Only certificates that pick it"}
                      </td>
                      <td className="whitespace-nowrap py-3 pl-2.5 pr-5">
                        <span className="flex justify-end gap-1.5">
                          {!isDefault && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={disabled}
                              aria-label={`Make ${label} the default`}
                              onClick={() => run({ action: "set-default", provider: name })}
                            >
                              Set default
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={disabled}
                            aria-label={`Edit ${label} credentials`}
                            onClick={() => setEditing(name)}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            disabled={disabled}
                            aria-label={`Remove ${label}`}
                            onClick={() => run({ action: "remove", provider: name })}
                          >
                            Remove
                          </Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {dnsProvider?.default && (
            <div className="flex justify-end border-t border-line px-5 py-3">
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => run({ action: "set-default", provider: "none" })}>
                Clear default
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {editing !== null && (
            <ProviderDialogBody
              initialProvider={editing}
              definitions={dnsProviderDefinitions}
              configured={configured}
              isSlave={isSlave}
              override={override}
              onDone={(message) => {
                setEditing(null);
                setResult({ success: true, message });
              }}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

function DnsResolversCard({ dns, isSlave, override: initialOverride }: { dns: DnsSettings | null; isSlave: boolean; override: boolean }) {
  const [override, setOverride] = useState(initialOverride);
  const [resolversOn, setResolversOn] = useState(dns?.enabled ?? false);
  const disabled = isSlave && !override;
  return (
    <SectionCard id="dns-resolvers" className="scroll-mt-20 md:scroll-mt-4" title="DNS-01 resolvers" headingLevel={2} divided={false}>
      <SettingsForm action={updateDnsSettingsAction} order={2}>
        <SettingRows>
          {isSlave && <OverrideRow id="dns-override" checked={override} onCheckedChange={setOverride} />}
          <SettingRow label="Own resolvers" hint="For slow propagation or split-horizon DNS.">
            <ToggleField
              id="dns-enabled"
              name="enabled"
              label="Use my own resolvers"
              checked={resolversOn}
              onCheckedChange={setResolversOn}
              disabled={disabled}
            />
          </SettingRow>
          {/* Kept in the form while off, so turning resolvers off keeps the list. */}
          <div hidden={!resolversOn}>
            <SettingRow label="Primary resolvers" htmlFor="settings-dns-resolvers-list" hint="One per line.">
              <Textarea
                id="settings-dns-resolvers-list"
                name="resolvers"
                placeholder={"1.1.1.1\n8.8.8.8"}
                defaultValue={dns?.resolvers?.join("\n") ?? ""}
                rows={2}
                disabled={disabled}
                className="num min-h-0"
              />
            </SettingRow>
            <SettingRow label="Fallback resolvers" htmlFor="settings-dns-fallbacks">
              <Textarea
                id="settings-dns-fallbacks"
                name="fallbacks"
                placeholder={"8.8.4.4\n1.0.0.1"}
                defaultValue={dns?.fallbacks?.join("\n") ?? ""}
                rows={2}
                disabled={disabled}
                className="num min-h-0"
              />
            </SettingRow>
            <SettingRow label="Query timeout" htmlFor="settings-dns-timeout">
              <Input
                id="settings-dns-timeout"
                name="timeout"
                placeholder="5s"
                defaultValue={dns?.timeout ?? ""}
                disabled={disabled}
                className="num w-[120px]"
              />
            </SettingRow>
          </div>
        </SettingRows>
      </SettingsForm>
    </SectionCard>
  );
}

/** Add a DNS provider or replace a configured one's credentials. */
function ProviderDialogBody({
  initialProvider,
  definitions,
  configured,
  isSlave,
  override,
  onDone,
  onClose,
}: {
  initialProvider: string;
  definitions: DnsProviderDefinition[];
  configured: string[];
  isSlave: boolean;
  override: boolean;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(initialProvider || "none");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const definition = definitions.find((provider) => provider.name === selected);
  const isUpdate = configured.includes(selected);

  return (
    <form
      id="dnsp-add-form"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (isSlave) data.set("overrideEnabled", override ? "on" : "");
        setError(null);
        startTransition(async () => {
          try {
            const result = await updateDnsProviderSettingsAction(null, data);
            if (result.success) onDone(result.message ?? "Saved");
            else setError(result.message ?? "Could not save the DNS provider");
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not save the DNS provider");
          }
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>{isUpdate ? `Edit ${definition?.displayName ?? selected}` : "Add a DNS provider"}</DialogTitle>
        <DialogDescription>
          {isUpdate ? "Blank fields keep their stored values." : "It becomes the default if there is none."}
        </DialogDescription>
      </DialogHeader>
      <input type="hidden" name="action" value="save" />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="settings-dns-provider" className="text-sm font-medium">
          Provider
        </label>
        {initialProvider ? (
          <>
            <input type="hidden" name="provider" value={initialProvider} />
            <span id="settings-dns-provider" className="flex h-9 items-center text-sm font-semibold">
              {definition?.displayName ?? initialProvider}
            </span>
          </>
        ) : (
          <Select name="provider" value={selected} onValueChange={setSelected}>
            <SelectTrigger id="settings-dns-provider" aria-label="DNS provider">
              <SelectValue placeholder="Choose a DNS provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Choose a provider</SelectItem>
              {definitions.map((provider) => (
                <SelectItem key={provider.name} value={provider.name}>
                  {provider.displayName}
                  {configured.includes(provider.name) ? " (configured)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {definition && (
        <>
          {definition.description && <p className="text-[13px] text-muted-foreground">{definition.description}</p>}
          {definition.fields.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <label htmlFor={`dns-credential-${field.key}`} className="text-sm font-medium">
                {field.label}
                {field.required ? "" : " (optional)"}
              </label>
              <Input
                id={`dns-credential-${field.key}`}
                name={`credential_${field.key}`}
                type={field.type === "password" ? "password" : "text"}
                autoComplete={field.type === "password" ? "new-password" : "off"}
                placeholder={isUpdate ? "Leave blank to keep" : field.placeholder ?? ""}
                className={field.type === "password" ? undefined : "num"}
              />
              {field.description && <p className="text-xs text-soft">{field.description}</p>}
            </div>
          ))}
          {definition.docsUrl && (
            <a href={definition.docsUrl} target="_blank" rel="noopener noreferrer" className="text-[13px] text-brand underline-offset-4 hover:underline">
              Provider documentation
            </a>
          )}
        </>
      )}
      {error && (
        <Banner tone="bad" live>
          {error}
        </Banner>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !definition}>
          {isUpdate ? "Update provider" : "Add provider"}
        </Button>
      </DialogFooter>
    </form>
  );
}

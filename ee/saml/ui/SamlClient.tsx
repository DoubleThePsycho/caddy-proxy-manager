// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Download, IdCard, Pencil, Plus, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { Banner } from "@/components/ui/Banner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AppDialog } from "@/components/ui/AppDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import type { SamlRole } from "@/ee/saml/constants";
import type { SamlProviderView } from "@/ee/saml/types";

const LOCKED_HINT = "Needs a license with SAML single sign-on";

type Props = {
  providers: SamlProviderView[];
  configurable: boolean;
  canWrite: boolean;
  secureBaseUrl: boolean;
  editionLabel: string;
};

type Mapping = { group: string; role: SamlRole };

type Form = {
  name: string;
  enabled: boolean;
  /** "metadata": paste the IdP metadata; "manual": entity ID, URL and certificates. */
  source: "metadata" | "manual";
  idpMetadataXml: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificates: string;
  /** keep | generate | remove */
  spKey: "keep" | "generate" | "remove";
  subjectAttribute: string;
  emailAttribute: string;
  nameAttribute: string;
  groupsAttribute: string;
  groupRoleMappings: Mapping[];
  defaultRole: "user" | "viewer";
  requiredGroup: string;
  provisionUsers: boolean;
  linkExistingAccounts: boolean;
};

function emptyForm(): Form {
  return {
    name: "",
    enabled: true,
    source: "metadata",
    idpMetadataXml: "",
    idpEntityId: "",
    idpSsoUrl: "",
    idpCertificates: "",
    spKey: "keep",
    subjectAttribute: "",
    emailAttribute: "email",
    nameAttribute: "",
    groupsAttribute: "",
    groupRoleMappings: [],
    defaultRole: "user",
    requiredGroup: "",
    provisionUsers: false,
    linkExistingAccounts: false,
  };
}

/** Attribute names the common identity providers send; every field stays editable. */
const PRESETS: Record<"entra" | "okta" | "google" | "keycloak", Partial<Form>> = {
  entra: {
    subjectAttribute: "http://schemas.microsoft.com/identity/claims/objectidentifier",
    emailAttribute: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    nameAttribute: "http://schemas.microsoft.com/identity/claims/displayname",
    groupsAttribute: "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
  },
  okta: { subjectAttribute: "userId", emailAttribute: "email", nameAttribute: "name", groupsAttribute: "groups" },
  google: { subjectAttribute: "", emailAttribute: "email", nameAttribute: "", groupsAttribute: "groups" },
  keycloak: { subjectAttribute: "", emailAttribute: "email", nameAttribute: "", groupsAttribute: "groups" },
};

function formFromProvider(provider: SamlProviderView): Form {
  return {
    ...emptyForm(),
    name: provider.name,
    enabled: provider.enabled,
    source: "manual",
    idpEntityId: provider.idpEntityId,
    idpSsoUrl: provider.idpSsoUrl,
    idpCertificates: provider.idpCertificates.join("\n"),
    subjectAttribute: provider.subjectAttribute ?? "",
    emailAttribute: provider.emailAttribute,
    nameAttribute: provider.nameAttribute ?? "",
    groupsAttribute: provider.groupsAttribute ?? "",
    groupRoleMappings: provider.groupRoleMappings.map((mapping) => ({ ...mapping })),
    defaultRole: provider.defaultRole,
    requiredGroup: provider.requiredGroup ?? "",
    provisionUsers: provider.provisionUsers,
    linkExistingAccounts: provider.linkExistingAccounts,
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (HTTP ${response.status})`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({ checked, onChange, children, disabled }: { checked: boolean; onChange: (value: boolean) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
      <span>{children}</span>
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-4">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {children}
    </fieldset>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy");
    }
  }
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <Input readOnly value={value} className="num text-xs" />
        <Button type="button" variant="outline" size="icon" onClick={copy} title="Copy" aria-label={`Copy ${label}`}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </Field>
  );
}

export default function SamlClient({ providers, configurable, canWrite, secureBaseUrl, editionLabel }: Props) {
  const router = useRouter();
  const { productName } = useBranding();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<SamlProviderView | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SamlProviderView | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<SamlProviderView | null>(null);

  const canChange = configurable && canWrite;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((previous) => ({ ...previous, [key]: value }));

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(provider: SamlProviderView) {
    setEditing(provider);
    setForm(formFromProvider(provider));
    setFormError(null);
    setFormOpen(true);
  }

  function save() {
    setFormError(null);
    const body: Record<string, unknown> = {
      name: form.name,
      enabled: form.enabled,
      subjectAttribute: form.subjectAttribute.trim() || null,
      emailAttribute: form.emailAttribute,
      nameAttribute: form.nameAttribute.trim() || null,
      groupsAttribute: form.groupsAttribute.trim() || null,
      groupRoleMappings: form.groupsAttribute.trim() ? form.groupRoleMappings.filter((mapping) => mapping.group.trim()) : [],
      defaultRole: form.defaultRole,
      requiredGroup: form.groupsAttribute.trim() ? form.requiredGroup.trim() || null : null,
      provisionUsers: form.provisionUsers,
      linkExistingAccounts: form.linkExistingAccounts,
    };
    if (form.source === "metadata") {
      body.idpMetadataXml = form.idpMetadataXml;
    } else {
      body.idpEntityId = form.idpEntityId;
      body.idpSsoUrl = form.idpSsoUrl;
      body.idpCertificates = form.idpCertificates;
    }
    if (form.spKey === "generate") body.generateSpKey = true;
    if (form.spKey === "remove") body.spPrivateKey = null;
    startTransition(async () => {
      try {
        const saved = await requestJson<SamlProviderView>(
          editing ? `/api/v1/saml-providers/${editing.id}` : "/api/v1/saml-providers",
          jsonInit(editing ? "PUT" : "POST", body)
        );
        toast.success(editing ? "Provider updated" : "Provider created");
        setFormOpen(false);
        // A new provider's SP URLs exist only now; show them for the IdP setup.
        if (!editing) setDetailsTarget(saved);
        router.refresh();
      } catch (error) {
        setFormError((error as Error).message);
      }
    });
  }

  function setEnabled(provider: SamlProviderView, enabled: boolean) {
    startTransition(async () => {
      try {
        await requestJson(`/api/v1/saml-providers/${provider.id}`, jsonInit("PUT", { enabled }));
      } catch (error) {
        toast.error((error as Error).message);
      }
      router.refresh();
    });
  }

  function remove() {
    if (!deleteTarget) return;
    const provider = deleteTarget;
    startTransition(async () => {
      try {
        const response = await fetch(`/api/v1/saml-providers/${provider.id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(await readError(response));
        toast.success("Provider deleted");
      } catch (error) {
        toast.error((error as Error).message);
      }
      setDeleteTarget(null);
      router.refresh();
    });
  }

  const hasGroups = form.groupsAttribute.trim().length > 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Identity", { label: "Sign-in and directories", href: "/sign-in" }, "SAML"]}
        title="SAML"
        description={`Let people sign in to ${productName} through a SAML 2.0 identity provider such as Microsoft Entra ID, Okta, Google Workspace or Keycloak. Groups can decide their role. This covers the dashboard only; the forward-auth portal is not affected.`}
        actions={canWrite ? (
          <Button onClick={openCreate} disabled={!canChange || pending} title={configurable ? undefined : LOCKED_HINT}>
            <Plus /> Add provider
          </Button>
        ) : undefined}
      />

      {!configurable && (
        <Banner tone="info" title="Read-only without a license.">
          Setting up and changing SAML providers needs an active {productName} {editionLabel} license or higher. Enabled
          providers keep working for sign-in, and you can still disable and delete them.{" "}
          <Link href="/license" className="text-brand underline-offset-4 hover:underline">Manage the license</Link>
        </Banner>
      )}
      {!secureBaseUrl && (
        <Banner tone="bad" title="BASE_URL does not use https.">
          SAML sign-in needs it: browsers drop the cookie that ties the identity provider&apos;s answer to the browser that started
          the sign-in.
        </Banner>
      )}

      <SectionCard
        title="SAML identity providers"
        count={providers.length}
        description="Started by the login page only; answers the provider sends on its own are refused."
      >
        <p className="m-0 border-b border-line px-[18px] py-3 text-[13px] text-muted-foreground">
          Responses must be signed with RSA-SHA256 or stronger by one of the provider&apos;s certificates. Accounts are linked by a
          persistent NameID or an immutable id attribute, never by e-mail unless you choose so.
        </p>
        {providers.length === 0 ? (
          <EmptyState
            compact
            icon={IdCard}
            title="No SAML providers yet"
            description="Add your identity provider's metadata, then give it this dashboard's service provider details."
            action={canWrite ? (
              <Button size="sm" onClick={openCreate} disabled={!canChange || pending}>
                <Plus /> Add provider
              </Button>
            ) : undefined}
          />
        ) : (
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">On</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Identity provider</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Accounts</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell>
                    <Switch
                      checked={provider.enabled}
                      // Turning off always works; turning on needs the license.
                      disabled={!canWrite || pending || (!configurable && !provider.enabled)}
                      onCheckedChange={(checked) => setEnabled(provider, checked)}
                      aria-label={provider.enabled ? "Disable provider" : "Enable provider"}
                      title={!configurable && !provider.enabled ? LOCKED_HINT : undefined}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{provider.name}</div>
                    {provider.warnings.map((warning) => (
                      <p key={warning} className="max-w-sm text-xs text-warn">{warning}</p>
                    ))}
                  </TableCell>
                  <TableCell className="text-sm">
                    <div className="num break-all text-xs">{provider.idpEntityId}</div>
                    <div className="text-xs text-muted-foreground">
                      {provider.certificates.length} certificate{provider.certificates.length === 1 ? "" : "s"}
                      {provider.signsRequests ? " · signed requests" : ""}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {provider.groupRoleMappings.length > 0
                      ? `${provider.groupRoleMappings.length} group mapping${provider.groupRoleMappings.length === 1 ? "" : "s"}`
                      : <span className="text-muted-foreground">Managed on the Users page</span>}
                    {provider.requiredGroup && <div className="text-xs text-muted-foreground">Required group set</div>}
                  </TableCell>
                  <TableCell className="text-sm">
                    <div><span className="num">{provider.linkedAccounts}</span> linked</div>
                    <div className="text-xs text-muted-foreground">
                      {[provider.provisionUsers ? "creates accounts" : null, provider.linkExistingAccounts ? "links by e-mail" : null]
                        .filter(Boolean)
                        .join(", ") || "existing links only"}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <Button variant="ghost" size="icon-sm" title="Service provider details" aria-label={`Details of "${provider.name}"`}
                      onClick={() => setDetailsTarget(provider)}>
                      <IdCard />
                    </Button>
                    <Button variant="ghost" size="icon-sm" title="Download SP metadata" aria-label={`Download the metadata of "${provider.name}"`} asChild>
                      <a href={`/api/v1/saml-providers/${provider.id}/metadata`} download>
                        <Download />
                      </a>
                    </Button>
                    {canWrite && (
                      <>
                        <Button variant="ghost" size="icon-sm" title={configurable ? "Edit" : LOCKED_HINT} aria-label={`Edit "${provider.name}"`}
                          disabled={!configurable || pending} onClick={() => openEdit(provider)}>
                          <Pencil />
                        </Button>
                        <Button variant="ghost" size="icon-sm" className="text-bad hover:text-bad" title="Delete" aria-label={`Delete "${provider.name}"`}
                          disabled={pending} onClick={() => setDeleteTarget(provider)}>
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <AppDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Edit SAML provider "${editing.name}"` : "Add SAML provider"}
        submitLabel={editing ? "Save" : "Create"}
        onSubmit={save}
        isSubmitting={pending}
        maxWidth="xl"
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="saml-name" hint="Shown on the login page as Continue with ….">
              <Input id="saml-name" value={form.name} maxLength={100} onChange={(event) => set("name", event.target.value)} />
            </Field>
            <Field label="Identity provider" hint="Fills in the attribute names; every field stays editable.">
              <Select onValueChange={(value) => setForm((previous) => ({ ...previous, ...PRESETS[value as keyof typeof PRESETS] }))}>
                <SelectTrigger aria-label="Identity provider">
                  <SelectValue placeholder="Choose (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="entra">Microsoft Entra ID</SelectItem>
                  <SelectItem value="okta">Okta</SelectItem>
                  <SelectItem value="google">Google Workspace</SelectItem>
                  <SelectItem value="keycloak">Keycloak</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Section title="Identity provider">
            <Field label="How to enter it">
              <Select value={form.source} onValueChange={(value) => set("source", value as Form["source"])}>
                <SelectTrigger aria-label="How to enter the identity provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="metadata">Paste the IdP metadata XML</SelectItem>
                  <SelectItem value="manual">Enter entity ID, URL and certificates</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {form.source === "metadata" ? (
              <Field label="IdP metadata XML" htmlFor="saml-metadata"
                hint="Read once when you save: the entity ID, the HTTP-Redirect sign-in URL and the signing certificates. It is never fetched from a URL.">
                <Textarea id="saml-metadata" rows={6} className="num text-xs" value={form.idpMetadataXml}
                  placeholder="<md:EntityDescriptor …>" onChange={(event) => set("idpMetadataXml", event.target.value)} />
              </Field>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="IdP entity ID" htmlFor="saml-entity-id">
                    <Input id="saml-entity-id" value={form.idpEntityId} placeholder="https://idp.example.com/saml"
                      onChange={(event) => set("idpEntityId", event.target.value)} />
                  </Field>
                  <Field label="Single sign-on URL (HTTP-Redirect)" htmlFor="saml-sso-url">
                    <Input id="saml-sso-url" value={form.idpSsoUrl} placeholder="https://idp.example.com/saml/sso"
                      onChange={(event) => set("idpSsoUrl", event.target.value)} />
                  </Field>
                </div>
                <Field label="Signing certificates (PEM)" htmlFor="saml-certificates"
                  hint="One or more, for certificate rollover. RSA only. Responses signed by any of them are accepted.">
                  <Textarea id="saml-certificates" rows={4} className="num text-xs" value={form.idpCertificates}
                    placeholder="-----BEGIN CERTIFICATE-----" onChange={(event) => set("idpCertificates", event.target.value)} />
                </Field>
              </>
            )}
          </Section>

          <Section title="Signed requests (optional)">
            <p className="text-xs text-muted-foreground">
              {editing?.signsRequests
                ? "AuthnRequests are signed with a stored key; its certificate is in the SP metadata."
                : "AuthnRequests are not signed. Generate a key if the identity provider requires signed requests."}
            </p>
            <Select value={form.spKey} onValueChange={(value) => set("spKey", value as Form["spKey"])}>
              <SelectTrigger aria-label="SP signing key">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">{editing?.signsRequests ? "Keep the current key" : "Do not sign requests"}</SelectItem>
                <SelectItem value="generate">Generate a new signing key</SelectItem>
                {editing?.hasSpPrivateKey && <SelectItem value="remove">Remove the key (unsigned requests)</SelectItem>}
              </SelectContent>
            </Select>
          </Section>

          <Section title="Attributes">
            <Field label="Account id attribute (optional)" htmlFor="saml-subject"
              hint="An immutable id, such as Entra ID's objectidentifier. Leave empty to use the NameID, which must then be persistent. Naming the e-mail attribute here links accounts by e-mail address, which can change.">
              <Input id="saml-subject" value={form.subjectAttribute} onChange={(event) => set("subjectAttribute", event.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="E-mail attribute" htmlFor="saml-email">
                <Input id="saml-email" value={form.emailAttribute} onChange={(event) => set("emailAttribute", event.target.value)} />
              </Field>
              <Field label="Name attribute (optional)" htmlFor="saml-name-attr">
                <Input id="saml-name-attr" value={form.nameAttribute} onChange={(event) => set("nameAttribute", event.target.value)} />
              </Field>
              <Field label="Groups attribute (optional)" htmlFor="saml-groups">
                <Input id="saml-groups" value={form.groupsAttribute} onChange={(event) => set("groupsAttribute", event.target.value)} />
              </Field>
            </div>
          </Section>

          {hasGroups && (
            <Section title="Groups and roles">
              <div className="space-y-2">
                <Label>Group-to-role mapping</Label>
                <p className="text-xs text-muted-foreground">
                  The only way SAML grants a role. With at least one mapping, every sign-in sets the role (the highest of
                  the matched groups, otherwise the default role), demoting as well as promoting. Group values are compared
                  exactly as the identity provider sends them. Without mappings, roles are managed on the Users page.
                </p>
                {form.groupRoleMappings.map((mapping, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input aria-label="Group" value={mapping.group} placeholder="ingressi-admins"
                      onChange={(event) => set("groupRoleMappings", form.groupRoleMappings.map((item, i) => (i === index ? { ...item, group: event.target.value } : item)))} />
                    <Select value={mapping.role}
                      onValueChange={(value) => set("groupRoleMappings", form.groupRoleMappings.map((item, i) => (i === index ? { ...item, role: value as SamlRole } : item)))}>
                      <SelectTrigger className="w-32" aria-label="Role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">admin</SelectItem>
                        <SelectItem value="user">user</SelectItem>
                        <SelectItem value="viewer">viewer</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="icon" aria-label="Remove mapping"
                      onClick={() => set("groupRoleMappings", form.groupRoleMappings.filter((_, i) => i !== index))}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm"
                  onClick={() => set("groupRoleMappings", [...form.groupRoleMappings, { group: "", role: "user" }])}>
                  <Plus className="h-4 w-4" /> Add mapping
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Default role" hint="For a user in none of the mapped groups. Never admin.">
                  <Select value={form.defaultRole} onValueChange={(value) => set("defaultRole", value as "user" | "viewer")}>
                    <SelectTrigger aria-label="Default role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">user</SelectItem>
                      <SelectItem value="viewer">viewer</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Required group (optional)" htmlFor="saml-required-group" hint="Only users with this group can sign in.">
                  <Input id="saml-required-group" value={form.requiredGroup} onChange={(event) => set("requiredGroup", event.target.value)} />
                </Field>
              </div>
            </Section>
          )}

          <Section title="Accounts">
            <Toggle checked={form.provisionUsers} onChange={(checked) => set("provisionUsers", checked)}>
              Create an account at first sign-in, with the asserted e-mail address and name (off: only existing links sign in)
            </Toggle>
            <Toggle checked={form.linkExistingAccounts} onChange={(checked) => set("linkExistingAccounts", checked)}>
              Link an existing account whose e-mail address is exactly the asserted one (never an administrator, a
              custom-role user, the primary admin or a break-glass account). Whoever controls that address at the
              identity provider can then sign in to the account.
            </Toggle>
            <Toggle checked={form.enabled} onChange={(checked) => set("enabled", checked)}>
              Enabled
            </Toggle>
          </Section>

          {formError && <Banner tone="bad" live>{formError}</Banner>}
        </div>
      </AppDialog>

      <AppDialog
        open={detailsTarget !== null}
        onClose={() => setDetailsTarget(null)}
        title={detailsTarget ? `"${detailsTarget.name}": service provider details` : "Service provider details"}
        maxWidth="lg"
      >
        {detailsTarget && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Enter these at the identity provider, or give it the metadata URL. They follow BASE_URL: changing it means
              updating the identity provider too.
            </p>
            <CopyField label="Entity ID (audience)" value={detailsTarget.sp.entityId} />
            <CopyField label="Assertion consumer service URL (HTTP-POST)" value={detailsTarget.sp.acsUrl} />
            <CopyField label="Metadata URL" value={detailsTarget.sp.metadataUrl} />
            {detailsTarget.certificates.length > 0 && (
              <div className="space-y-1 text-xs">
                <p className="font-medium text-sm">IdP signing certificates</p>
                {detailsTarget.certificates.map((certificate) => (
                  <div key={certificate.fingerprint} className="rounded-lg border border-line p-2">
                    <div className="break-all">{certificate.subject}</div>
                    <div className="num break-all text-muted-foreground">SHA-256 {certificate.fingerprint}</div>
                    <div className="text-muted-foreground">
                      Valid until {new Date(certificate.notAfter).toLocaleDateString()}
                      {certificate.expired && <Badge variant="warning" className="ml-2">expired</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </AppDialog>

      <AppDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete SAML provider "${deleteTarget.name}"?` : "Delete SAML provider"}
        submitLabel="Delete"
        onSubmit={remove}
        isSubmitting={pending}
      >
        <p className="text-sm text-muted-foreground">
          {deleteTarget?.linkedAccounts
            ? `${deleteTarget.linkedAccounts} account${deleteTarget.linkedAccounts === 1 ? " is" : "s are"} unlinked. The users are kept; those without a password or another sign-in method can no longer sign in.`
            : "No account is linked to it."}
        </p>
      </AppDialog>
    </div>
  );
}

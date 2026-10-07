// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BookUser, KeyRound, Pencil, Plug, Plus, Trash2, X } from "lucide-react";
import { SectionCard } from "@/components/ui/SectionCard";
import { Banner } from "@/components/ui/Banner";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusDot } from "@/components/ui/StatusDot";
import { PageHeader } from "@/components/ui/PageHeader";
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
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { GroupMode, LdapRole } from "@/ee/ldap/constants";
import type { LdapDirectoryView } from "@/ee/ldap/types";
import type { ConnectionTestResult } from "@/ee/ldap/authenticate";
import type { SignInTestResult } from "@/ee/ldap/diagnostics";

const LOCKED_HINT = "Needs a license with LDAP / Active Directory";

type Props = {
  directories: LdapDirectoryView[];
  configurable: boolean;
  canWrite: boolean;
  ssoEnforced: boolean;
  editionLabel: string;
  /** The breadcrumb links to Sign-in and directories (sso:read). Default true. */
  canReadSignIn?: boolean;
};

type Mapping = { group: string; role: LdapRole };

type Form = {
  name: string;
  enabled: boolean;
  url: string;
  startTls: boolean;
  allowUnencrypted: boolean;
  caCertificate: string;
  connectTimeoutMs: string;
  operationTimeoutMs: string;
  bindDn: string;
  bindPassword: string;
  userSearchBase: string;
  userSearchFilter: string;
  usernameAttribute: string;
  emailAttribute: string;
  displayNameAttribute: string;
  uniqueIdAttribute: string;
  groupMode: GroupMode;
  groupMembershipAttribute: string;
  groupSearchBase: string;
  groupSearchFilter: string;
  nestedGroups: boolean;
  groupRoleMappings: Mapping[];
  defaultRole: "user" | "viewer";
  requiredGroup: string;
  provisionUsers: boolean;
  linkExistingAccounts: boolean;
  allowWhenSsoEnforced: boolean;
};

function emptyForm(): Form {
  return {
    name: "",
    enabled: true,
    url: "",
    startTls: false,
    allowUnencrypted: false,
    caCertificate: "",
    connectTimeoutMs: "5000",
    operationTimeoutMs: "10000",
    bindDn: "",
    bindPassword: "",
    userSearchBase: "",
    userSearchFilter: "(&(objectClass=inetOrgPerson)(uid={username}))",
    usernameAttribute: "uid",
    emailAttribute: "mail",
    displayNameAttribute: "cn",
    uniqueIdAttribute: "entryUUID",
    groupMode: "none",
    groupMembershipAttribute: "memberOf",
    groupSearchBase: "",
    groupSearchFilter: "",
    nestedGroups: false,
    groupRoleMappings: [],
    defaultRole: "user",
    requiredGroup: "",
    provisionUsers: false,
    linkExistingAccounts: false,
    allowWhenSsoEnforced: false,
  };
}

/** Starting points for the two common servers; every field stays editable. */
const PRESETS: Record<"ad" | "openldap", Partial<Form>> = {
  ad: {
    userSearchFilter:
      "(&(objectClass=user)(objectCategory=person)(sAMAccountName={username})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))",
    usernameAttribute: "sAMAccountName",
    emailAttribute: "mail",
    displayNameAttribute: "displayName",
    uniqueIdAttribute: "objectGUID",
    groupMode: "member_of",
    groupMembershipAttribute: "memberOf",
    groupSearchFilter: "",
  },
  openldap: {
    userSearchFilter: "(&(objectClass=inetOrgPerson)(uid={username}))",
    usernameAttribute: "uid",
    emailAttribute: "mail",
    displayNameAttribute: "cn",
    uniqueIdAttribute: "entryUUID",
    groupMode: "search",
    groupSearchFilter: "(&(objectClass=groupOfNames)(member={dn}))",
    nestedGroups: false,
  },
};

function formFromDirectory(directory: LdapDirectoryView): Form {
  return {
    ...emptyForm(),
    name: directory.name,
    enabled: directory.enabled,
    url: directory.url,
    startTls: directory.startTls,
    allowUnencrypted: directory.allowUnencrypted,
    caCertificate: directory.caCertificate ?? "",
    connectTimeoutMs: String(directory.connectTimeoutMs),
    operationTimeoutMs: String(directory.operationTimeoutMs),
    bindDn: directory.bindDn,
    userSearchBase: directory.userSearchBase,
    userSearchFilter: directory.userSearchFilter,
    usernameAttribute: directory.usernameAttribute,
    emailAttribute: directory.emailAttribute,
    displayNameAttribute: directory.displayNameAttribute,
    uniqueIdAttribute: directory.uniqueIdAttribute,
    groupMode: directory.groupMode,
    groupMembershipAttribute: directory.groupMembershipAttribute,
    groupSearchBase: directory.groupSearchBase ?? "",
    groupSearchFilter: directory.groupSearchFilter ?? "",
    nestedGroups: directory.nestedGroups,
    groupRoleMappings: directory.groupRoleMappings.map((mapping) => ({ ...mapping })),
    defaultRole: directory.defaultRole,
    requiredGroup: directory.requiredGroup ?? "",
    provisionUsers: directory.provisionUsers,
    linkExistingAccounts: directory.linkExistingAccounts,
    allowWhenSsoEnforced: directory.allowWhenSsoEnforced,
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

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: React.ReactNode; hint?: string }) {
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

function transport(directory: LdapDirectoryView): { label: string; variant: "success" | "destructive" } {
  if (directory.url.startsWith("ldaps:")) return { label: "TLS", variant: "success" };
  if (directory.startTls) return { label: "StartTLS", variant: "success" };
  return { label: "Unencrypted", variant: "destructive" };
}

const OUTCOME_LABELS: Record<SignInTestResult["outcome"], string> = {
  success: "The directory accepted the password",
  invalid_input: "Username or password missing",
  directory_unavailable: "The directory could not be reached or searched",
  unknown_user: "No entry matches the username",
  multiple_entries: "More than one entry matches the username",
  wrong_password: "Wrong password",
  incomplete_entry: "The entry lacks a usable attribute",
  groups_unavailable: "The groups could not be read",
};

export default function LdapClient({ directories, configurable, canWrite, ssoEnforced, editionLabel, canReadSignIn = true }: Props) {
  const router = useRouter();
  const { productName } = useBranding();
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<LdapDirectoryView | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LdapDirectoryView | null>(null);
  const [testTarget, setTestTarget] = useState<LdapDirectoryView | null>(null);
  const [testUsername, setTestUsername] = useState("");
  const [testPassword, setTestPassword] = useState("");
  const [testResult, setTestResult] = useState<SignInTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const canChange = configurable && canWrite;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((previous) => ({ ...previous, [key]: value }));

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(directory: LdapDirectoryView) {
    setEditing(directory);
    setForm(formFromDirectory(directory));
    setFormError(null);
    setFormOpen(true);
  }

  function setUrl(url: string) {
    // ldap:// starts with StartTLS on; ldaps:// needs neither switch.
    setForm((previous) => ({
      ...previous,
      url,
      startTls: url.trim().toLowerCase().startsWith("ldap://") ? previous.startTls || !previous.allowUnencrypted : false,
      allowUnencrypted: url.trim().toLowerCase().startsWith("ldap://") ? previous.allowUnencrypted : false,
    }));
  }

  function save() {
    setFormError(null);
    const body: Record<string, unknown> = {
      name: form.name,
      enabled: form.enabled,
      url: form.url,
      startTls: form.startTls,
      allowUnencrypted: form.allowUnencrypted,
      caCertificate: form.caCertificate.trim() || null,
      connectTimeoutMs: Number(form.connectTimeoutMs),
      operationTimeoutMs: Number(form.operationTimeoutMs),
      bindDn: form.bindDn,
      userSearchBase: form.userSearchBase,
      userSearchFilter: form.userSearchFilter,
      usernameAttribute: form.usernameAttribute,
      emailAttribute: form.emailAttribute,
      displayNameAttribute: form.displayNameAttribute,
      uniqueIdAttribute: form.uniqueIdAttribute,
      groupMode: form.groupMode,
      groupMembershipAttribute: form.groupMembershipAttribute,
      groupSearchBase: form.groupSearchBase.trim() || null,
      groupSearchFilter: form.groupSearchFilter.trim() || null,
      nestedGroups: form.groupMode === "member_of" && form.nestedGroups,
      groupRoleMappings: form.groupMode === "none" ? [] : form.groupRoleMappings.filter((mapping) => mapping.group.trim()),
      defaultRole: form.defaultRole,
      requiredGroup: form.groupMode === "none" ? null : form.requiredGroup.trim() || null,
      provisionUsers: form.provisionUsers,
      linkExistingAccounts: form.linkExistingAccounts,
      allowWhenSsoEnforced: form.allowWhenSsoEnforced,
    };
    if (form.bindPassword) body.bindPassword = form.bindPassword;
    startTransition(async () => {
      try {
        await requestJson(
          editing ? `/api/v1/ldap-directories/${editing.id}` : "/api/v1/ldap-directories",
          jsonInit(editing ? "PUT" : "POST", body)
        );
        toast.success(editing ? "Directory updated" : "Directory created");
        setFormOpen(false);
        router.refresh();
      } catch (error) {
        setFormError((error as Error).message);
      }
    });
  }

  function setEnabled(directory: LdapDirectoryView, enabled: boolean) {
    startTransition(async () => {
      try {
        await requestJson(`/api/v1/ldap-directories/${directory.id}`, jsonInit("PUT", { enabled }));
      } catch (error) {
        toast.error((error as Error).message);
      }
      router.refresh();
    });
  }

  function testConnection(directory: LdapDirectoryView) {
    startTransition(async () => {
      try {
        const result = await requestJson<ConnectionTestResult>(`/api/v1/ldap-directories/${directory.id}/test`, jsonInit("POST"));
        const failed = result.steps.find((step) => !step.ok);
        if (result.ok) toast.success(`"${directory.name}": connected, service account accepted, search base found`);
        else toast.error(`"${directory.name}": ${failed?.step ?? "connection"} failed: ${failed?.detail ?? "unknown error"}`);
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  }

  function openTestSignIn(directory: LdapDirectoryView) {
    setTestTarget(directory);
    setTestUsername("");
    setTestPassword("");
    setTestResult(null);
    setTestError(null);
  }

  function runTestSignIn() {
    if (!testTarget) return;
    const directory = testTarget;
    setTestError(null);
    setTestResult(null);
    startTransition(async () => {
      try {
        setTestResult(await requestJson<SignInTestResult>(
          `/api/v1/ldap-directories/${directory.id}/test-sign-in`,
          jsonInit("POST", { username: testUsername, password: testPassword })
        ));
      } catch (error) {
        setTestError((error as Error).message);
      }
      setTestPassword("");
    });
  }

  function remove() {
    if (!deleteTarget) return;
    const directory = deleteTarget;
    startTransition(async () => {
      try {
        const response = await fetch(`/api/v1/ldap-directories/${directory.id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(await readError(response));
        toast.success("Directory deleted");
      } catch (error) {
        toast.error((error as Error).message);
      }
      setDeleteTarget(null);
      router.refresh();
    });
  }

  const ldapUrl = form.url.trim().toLowerCase().startsWith("ldap://");
  const unencrypted = ldapUrl && !form.startTls;

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Users and sign-in", canReadSignIn ? { label: "Sign-in and directories", href: "/sign-in" } : "Sign-in and directories", "LDAP directories"]}
        title="LDAP directories"
        description={`Sign in to ${productName} with an LDAP or Active Directory account. The forward-auth portal is not affected.`}
        actions={canWrite ? (
          <Button onClick={openCreate} disabled={!canChange || pending} title={configurable ? undefined : LOCKED_HINT}>
            <Plus /> Add directory
          </Button>
        ) : undefined}
      />

      {!configurable && (
        <Banner tone="info" title="Read-only without a license.">
          Setting up and changing directories needs an active {productName} {editionLabel} license or higher. You can still test, disable
          and delete them.{" "}
          <Link href="/license" className="text-brand underline-offset-4 hover:underline">Manage the license</Link>
        </Banner>
      )}
      {ssoEnforced && (
        <Banner tone="info" title="Enforced SSO is on.">
          Directory sign-in is refused unless a directory has <span className="font-medium text-foreground">Allow while SSO is enforced</span> turned on.
        </Banner>
      )}

      <SectionCard title="LDAP and Active Directory" count={directories.length}>
        {directories.length === 0 ? (
          <EmptyState
            compact
            icon={BookUser}
            title="No directories yet"
            action={canWrite ? (
              <Button size="sm" onClick={openCreate} disabled={!canChange || pending}>
                <Plus /> Add directory
              </Button>
            ) : undefined}
          />
        ) : (
          <Table className="min-w-[960px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">On</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Server</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Accounts</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {directories.map((directory) => {
                const tls = transport(directory);
                const health = directory.health;
                return (
                  <TableRow key={directory.id}>
                    <TableCell>
                      <Switch
                        checked={directory.enabled}
                        // Turning off always works; turning on needs the license.
                        disabled={!canWrite || pending || (!configurable && !directory.enabled)}
                        onCheckedChange={(checked) => setEnabled(directory, checked)}
                        aria-label={directory.enabled ? "Disable directory" : "Enable directory"}
                        title={!configurable && !directory.enabled ? LOCKED_HINT : undefined}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{directory.name}</div>
                      {directory.warnings.map((warning) => (
                        <p key={warning} className="max-w-sm text-xs text-warn">{warning}</p>
                      ))}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className="num break-all text-xs">{directory.url}</span>
                        <Badge variant={tls.variant}>{tls.label}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {!directory.enabled ? (
                        <StatusDot tone="off" label="Not checked while off" />
                      ) : !health ? (
                        <StatusDot tone="info" label="Not checked yet" />
                      ) : health.status === "ok" ? (
                        <span className="flex flex-col gap-0.5">
                          <StatusDot tone="ok" label="Healthy" />
                          <span className="num text-xs text-soft">{format.dateTime(health.checkedAt)}</span>
                        </span>
                      ) : (
                        <span className="flex max-w-xs flex-col gap-0.5">
                          <StatusDot tone="bad" label={`Failing, ${health.consecutiveFailures} check${health.consecutiveFailures === 1 ? "" : "s"} in a row`} />
                          {health.lastError && <span className="num break-words text-xs text-soft">{health.lastError}</span>}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {directory.groupRoleMappings.length > 0
                        ? `${directory.groupRoleMappings.length} group mapping${directory.groupRoleMappings.length === 1 ? "" : "s"}`
                        : <span className="text-muted-foreground">Managed on the Users page</span>}
                      {directory.requiredGroup && <div className="text-xs text-muted-foreground">Required group set</div>}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div><span className="num">{directory.linkedAccounts}</span> linked</div>
                      <div className="text-xs text-muted-foreground">
                        {[directory.provisionUsers ? "creates accounts" : null, directory.linkExistingAccounts ? "links by e-mail" : null]
                          .filter(Boolean)
                          .join(", ") || "existing links only"}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {canWrite && (
                        <>
                          <Button variant="ghost" size="icon-sm" title="Test the connection" aria-label={`Test "${directory.name}"`}
                            disabled={pending} onClick={() => testConnection(directory)}>
                            <Plug />
                          </Button>
                          <Button variant="ghost" size="icon-sm" title="Test a sign-in" aria-label={`Test a sign-in to "${directory.name}"`}
                            disabled={pending} onClick={() => openTestSignIn(directory)}>
                            <KeyRound />
                          </Button>
                          <Button variant="ghost" size="icon-sm" title={configurable ? "Edit" : LOCKED_HINT} aria-label={`Edit "${directory.name}"`}
                            disabled={!configurable || pending} onClick={() => openEdit(directory)}>
                            <Pencil />
                          </Button>
                          <Button variant="ghost" size="icon-sm" className="text-bad hover:text-bad" title="Delete" aria-label={`Delete "${directory.name}"`}
                            disabled={pending} onClick={() => setDeleteTarget(directory)}>
                            <Trash2 />
                          </Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <AppDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Edit directory "${editing.name}"` : "Add directory"}
        submitLabel={editing ? "Save" : "Create"}
        onSubmit={save}
        isSubmitting={pending}
        maxWidth="xl"
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="ldap-name" hint="Shown on the login page.">
              <Input id="ldap-name" value={form.name} maxLength={100} onChange={(event) => set("name", event.target.value)} />
            </Field>
            <Field label="Server type" hint="Fills in filters and attributes.">
              <Select onValueChange={(value) => setForm((previous) => ({ ...previous, ...PRESETS[value as "ad" | "openldap"] }))}>
                <SelectTrigger aria-label="Server type">
                  <SelectValue placeholder="Choose (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ad">Active Directory</SelectItem>
                  <SelectItem value="openldap">OpenLDAP</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Section title="Connection">
            <Field label="URL" htmlFor="ldap-url" hint="ldaps://host:636, or ldap://host:389 with StartTLS.">
              <Input id="ldap-url" value={form.url} placeholder="ldaps://ldap.example.com:636" onChange={(event) => setUrl(event.target.value)} />
            </Field>
            {ldapUrl && (
              <Toggle checked={form.startTls} onChange={(checked) => set("startTls", checked)}>
                Use StartTLS (upgrade the connection to TLS before anything is sent)
              </Toggle>
            )}
            {ldapUrl && !form.startTls && (
              <Toggle checked={form.allowUnencrypted} onChange={(checked) => set("allowUnencrypted", checked)}>
                Allow unencrypted connections
              </Toggle>
            )}
            {unencrypted && (
              <Banner tone="bad">
                Without TLS, the service account password and every user&apos;s password cross the network in clear text.
                Use this only for a directory on the same host or a trusted private network.
              </Banner>
            )}
            <Field label="CA certificate (PEM, optional)" htmlFor="ldap-ca"
              hint="Empty: the system trust store.">
              <Textarea id="ldap-ca" rows={3} className="num text-xs" value={form.caCertificate}
                placeholder="-----BEGIN CERTIFICATE-----" onChange={(event) => set("caCertificate", event.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Connect timeout (ms)" htmlFor="ldap-connect-timeout">
                <Input id="ldap-connect-timeout" inputMode="numeric" value={form.connectTimeoutMs} onChange={(event) => set("connectTimeoutMs", event.target.value)} />
              </Field>
              <Field label="Operation timeout (ms)" htmlFor="ldap-operation-timeout">
                <Input id="ldap-operation-timeout" inputMode="numeric" value={form.operationTimeoutMs} onChange={(event) => set("operationTimeoutMs", event.target.value)} />
              </Field>
            </div>
          </Section>

          <Section title="Service account">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Bind DN" htmlFor="ldap-bind-dn" hint="A read-only account that can search users and groups.">
                <Input id="ldap-bind-dn" value={form.bindDn} placeholder="cn=ingressi,ou=services,dc=example,dc=com" onChange={(event) => set("bindDn", event.target.value)} />
              </Field>
              <Field label="Password" htmlFor="ldap-bind-password"
                hint={editing ? "Enter it again when you change the URL." : "Stored encrypted; never shown again."}>
                <Input id="ldap-bind-password" type="password" autoComplete="new-password" value={form.bindPassword}
                  placeholder={editing?.hasBindPassword ? "Stored; leave empty to keep" : ""}
                  onChange={(event) => set("bindPassword", event.target.value)} />
              </Field>
            </div>
          </Section>

          <Section title="Users">
            <Field label="User search base" htmlFor="ldap-user-base">
              <Input id="ldap-user-base" value={form.userSearchBase} placeholder="ou=people,dc=example,dc=com" onChange={(event) => set("userSearchBase", event.target.value)} />
            </Field>
            <Field label="User filter" htmlFor="ldap-user-filter"
              hint="{username} is replaced with what the person types, escaped. Exactly one entry must match.">
              <Input id="ldap-user-filter" className="num text-xs" value={form.userSearchFilter} onChange={(event) => set("userSearchFilter", event.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Username attribute" htmlFor="ldap-attr-username">
                <Input id="ldap-attr-username" value={form.usernameAttribute} onChange={(event) => set("usernameAttribute", event.target.value)} />
              </Field>
              <Field label="E-mail attribute" htmlFor="ldap-attr-email">
                <Input id="ldap-attr-email" value={form.emailAttribute} onChange={(event) => set("emailAttribute", event.target.value)} />
              </Field>
              <Field label="Display name attribute" htmlFor="ldap-attr-name">
                <Input id="ldap-attr-name" value={form.displayNameAttribute} onChange={(event) => set("displayNameAttribute", event.target.value)} />
              </Field>
              <Field label="Unique id attribute" htmlFor="ldap-attr-id" hint="entryUUID, or objectGUID for AD.">
                <Input id="ldap-attr-id" value={form.uniqueIdAttribute} onChange={(event) => set("uniqueIdAttribute", event.target.value)} />
              </Field>
            </div>
          </Section>

          <Section title="Groups and roles">
            <Field label="Group lookup">
              <Select value={form.groupMode} onValueChange={(value) => set("groupMode", value as GroupMode)}>
                <SelectTrigger aria-label="Group lookup">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None: roles are managed on the Users page</SelectItem>
                  <SelectItem value="member_of">Read an attribute of the user (memberOf)</SelectItem>
                  <SelectItem value="search">Search for groups</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {form.groupMode === "member_of" && (
              <>
                <Field label="Membership attribute" htmlFor="ldap-member-attr">
                  <Input id="ldap-member-attr" value={form.groupMembershipAttribute} onChange={(event) => set("groupMembershipAttribute", event.target.value)} />
                </Field>
                <Toggle checked={form.nestedGroups} onChange={(checked) => set("nestedGroups", checked)}>
                  Include nested groups (Active Directory only; searches below the group search base)
                </Toggle>
              </>
            )}
            {(form.groupMode === "search" || (form.groupMode === "member_of" && form.nestedGroups)) && (
              <Field label="Group search base" htmlFor="ldap-group-base">
                <Input id="ldap-group-base" value={form.groupSearchBase} placeholder="ou=groups,dc=example,dc=com" onChange={(event) => set("groupSearchBase", event.target.value)} />
              </Field>
            )}
            {form.groupMode === "search" && (
              <Field label="Group filter" htmlFor="ldap-group-filter" hint="{dn} is the user's DN and {username} the username attribute, both escaped.">
                <Input id="ldap-group-filter" className="num text-xs" value={form.groupSearchFilter}
                  placeholder="(&(objectClass=groupOfNames)(member={dn}))" onChange={(event) => set("groupSearchFilter", event.target.value)} />
              </Field>
            )}
            {form.groupMode !== "none" && (
              <>
                <div className="space-y-2">
                  <Label>Group-to-role mapping</Label>
                  <p className="text-xs text-muted-foreground">
                    With a mapping, every sign-in sets the role, demoting as well as promoting: the highest matched group, otherwise
                    the default role. Without mappings, roles are set on the Users page.
                  </p>
                  {form.groupRoleMappings.map((mapping, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input aria-label="Group DN" value={mapping.group} placeholder="cn=ingressi-admins,ou=groups,dc=example,dc=com"
                        onChange={(event) => set("groupRoleMappings", form.groupRoleMappings.map((item, i) => (i === index ? { ...item, group: event.target.value } : item)))} />
                      <Select value={mapping.role}
                        onValueChange={(value) => set("groupRoleMappings", form.groupRoleMappings.map((item, i) => (i === index ? { ...item, role: value as LdapRole } : item)))}>
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
                  <Field label="Required group (optional)" htmlFor="ldap-required-group" hint="Only members can sign in.">
                    <Input id="ldap-required-group" value={form.requiredGroup} placeholder="cn=ingressi-users,ou=groups,dc=example,dc=com"
                      onChange={(event) => set("requiredGroup", event.target.value)} />
                  </Field>
                </div>
              </>
            )}
          </Section>

          <Section title="Accounts">
            <Toggle checked={form.provisionUsers} onChange={(checked) => set("provisionUsers", checked)}>
              Create an account at first sign-in, with the entry&apos;s e-mail address and display name
            </Toggle>
            <Toggle checked={form.linkExistingAccounts} onChange={(checked) => set("linkExistingAccounts", checked)}>
              Link an existing account whose e-mail address is exactly the entry&apos;s (never an administrator, a
              custom-role user, the primary admin or a break-glass account). Whoever controls that address in the
              directory can then sign in to the account.
            </Toggle>
            <Toggle checked={form.allowWhenSsoEnforced} onChange={(checked) => set("allowWhenSsoEnforced", checked)}>
              Allow while SSO is enforced (off: directory sign-in is refused like password sign-in while enforced SSO is on)
            </Toggle>
            <Toggle checked={form.enabled} onChange={(checked) => set("enabled", checked)}>
              Enabled
            </Toggle>
          </Section>

          {formError && <Banner tone="bad" live>{formError}</Banner>}
        </div>
      </AppDialog>

      <AppDialog
        open={testTarget !== null}
        onClose={() => setTestTarget(null)}
        title={testTarget ? `Test a sign-in to "${testTarget.name}"` : "Test a sign-in"}
        submitLabel="Test"
        onSubmit={runTestSignIn}
        isSubmitting={pending}
        maxWidth="lg"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Shows what a sign-in would do. Nobody is signed in and no account changes. The attempt counts towards the sign-in limits.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Username" htmlFor="ldap-test-username">
              <Input id="ldap-test-username" autoComplete="off" value={testUsername} onChange={(event) => setTestUsername(event.target.value)} />
            </Field>
            <Field label="Password" htmlFor="ldap-test-password">
              <Input id="ldap-test-password" type="password" autoComplete="off" value={testPassword} onChange={(event) => setTestPassword(event.target.value)} />
            </Field>
          </div>
          {testError && <Banner tone="bad" live>{testError}</Banner>}
          {testResult && (
            <div className="space-y-3 text-sm" data-testid="ldap-test-result">
              <div className="flex items-center gap-2">
                <Badge variant={testResult.ok ? "success" : "destructive"}>{testResult.ok ? "Accepted" : "Refused"}</Badge>
                <span>{OUTCOME_LABELS[testResult.outcome]}</span>
              </div>
              <p className="text-xs text-muted-foreground">{testResult.detail}</p>
              {testResult.user && (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">DN</dt><dd className="num break-all">{testResult.user.dn}</dd>
                  <dt className="text-muted-foreground">Unique id</dt><dd className="num break-all">{testResult.user.uniqueId}</dd>
                  <dt className="text-muted-foreground">Username</dt><dd>{testResult.user.username}</dd>
                  <dt className="text-muted-foreground">E-mail</dt><dd>{testResult.user.email ?? "none"}</dd>
                  <dt className="text-muted-foreground">Display name</dt><dd>{testResult.user.displayName ?? "none"}</dd>
                  <dt className="text-muted-foreground">Groups</dt>
                  <dd className="break-all">{testResult.user.groups === null ? "not looked up" : testResult.user.groups.length === 0 ? "none" : testResult.user.groups.join("; ")}</dd>
                </dl>
              )}
              {testResult.roles && (
                <p>
                  Role: <span className="font-medium">{testResult.roles.role}</span>
                  {testResult.roles.managesRoles ? " (set at every sign-in)" : " (only for a new account; then managed on the Users page)"}
                  {!testResult.roles.inRequiredGroup && <span className="text-bad"> · not in the required group</span>}
                </p>
              )}
              {testResult.account && (
                <p>
                  Account:{" "}
                  {testResult.account.action === "existing" && `signs in to the linked account #${testResult.account.userId}`}
                  {testResult.account.action === "link" && `links the existing account #${testResult.account.userId}`}
                  {testResult.account.action === "provision" && "creates a new account"}
                  {testResult.account.action === "refuse" && <span className="text-bad">refused: {testResult.account.reason}</span>}
                </p>
              )}
            </div>
          )}
        </div>
      </AppDialog>

      <AppDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete directory "${deleteTarget.name}"?` : "Delete directory"}
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

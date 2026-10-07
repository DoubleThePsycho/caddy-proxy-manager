// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AppDialog } from "@/components/ui/AppDialog";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import type {
  ScimManagedGroupView,
  ScimManagedUserView,
  ScimRoleMappingView,
  ScimSettingsView,
  ScimTokenView,
} from "../types";
import ScimDirectoryCards from "./ScimDirectoryCards";
import { callApi, Field, formatDate } from "./shared";

export type ScimClientProps = {
  settings: ScimSettingsView;
  tokens: ScimTokenView[];
  mappings: ScimRoleMappingView[];
  managedUsers: ScimManagedUserView[];
  managedGroups: ScimManagedGroupView[];
  /** Accounts that can be handed to SCIM (not managed yet, not protected). */
  userOptions: { id: number; email: string; name: string | null }[];
  /** Forward-auth groups SCIM does not manage yet. */
  groupOptions: { id: number; name: string }[];
  customRoles: { id: number; name: string; adminLevel: boolean }[];
  canWrite: boolean;
  isAdmin: boolean;
  /** The breadcrumb links to Sign-in and directories (sso:read). Default true. */
  canReadSignIn?: boolean;
};

type SettingsForm = {
  enabled: boolean;
  providerId: string;
  deleteMode: "disable" | "delete";
  defaultRole: "user" | "viewer";
  manageRoles: boolean;
  requireVerifiedEmail: boolean;
  externalIdClaim: string;
};

const NO_PROVIDER = "__none__";

function formOf(settings: ScimSettingsView): SettingsForm {
  return {
    enabled: settings.enabled,
    providerId: settings.providerId ?? NO_PROVIDER,
    deleteMode: settings.deleteMode,
    defaultRole: settings.defaultRole,
    manageRoles: settings.manageRoles,
    requireVerifiedEmail: settings.requireVerifiedEmail,
    externalIdClaim: settings.externalIdClaim ?? "",
  };
}

function SettingsCard({ settings, canWrite }: { settings: ScimSettingsView; canWrite: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState<SettingsForm>(() => formOf(settings));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const editable = canWrite;
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => setForm((previous) => ({ ...previous, [key]: value }));

  function save() {
    setError(null);
    const body = {
      enabled: form.enabled,
      providerId: form.providerId === NO_PROVIDER ? null : form.providerId,
      deleteMode: form.deleteMode,
      defaultRole: form.defaultRole,
      manageRoles: form.manageRoles,
      requireVerifiedEmail: form.requireVerifiedEmail,
      externalIdClaim: form.externalIdClaim.trim() || null,
    };
    startTransition(async () => {
      try {
        const view = await callApi<ScimSettingsView>("/api/v1/scim/settings", "PUT", body);
        setForm(formOf(view));
        toast.success("SCIM settings saved");
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(settings.endpointUrl);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy");
    }
  }

  const provider = settings.providers.find((item) => item.id === form.providerId);

  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-center gap-2">
          SCIM endpoint
          <Badge variant={settings.enabled ? "success" : "secondary"}>{settings.enabled ? "On" : "Off"}</Badge>
        </span>
      }
      padded
      contentClassName="space-y-5"
    >
        <p className="m-0 text-[13px] text-muted-foreground">Give your identity provider this URL and a SCIM token.</p>
        <Field label="SCIM base URL (tenant URL)">
          <div className="flex gap-2">
            <Input readOnly value={settings.endpointUrl} className="num text-xs" />
            <Button variant="outline" size="icon" onClick={copyUrl} title="Copy" aria-label="Copy the SCIM base URL">
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </Field>

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="scim-enabled" className="flex flex-col items-start gap-1">
            <span>Accept SCIM requests</span>
            <span className="text-xs font-normal text-muted-foreground">While off, every SCIM request is refused; nothing is deleted.</span>
          </Label>
          <Switch id="scim-enabled" checked={form.enabled} onCheckedChange={(checked) => set("enabled", checked)} disabled={!editable || pending} />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Sign-in provider"
            htmlFor="scim-provider"
            hint="SCIM users have no password; their first sign-in through this provider links their account."
          >
            <Select value={form.providerId} onValueChange={(value) => set("providerId", value)} disabled={!editable || pending}>
              <SelectTrigger id="scim-provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROVIDER}>None</SelectItem>
                {settings.providers.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}{item.enabled ? "" : " (disabled)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="When the provider deletes a user" htmlFor="scim-delete-mode">
            <Select value={form.deleteMode} onValueChange={(value) => set("deleteMode", value as SettingsForm["deleteMode"])} disabled={!editable || pending}>
              <SelectTrigger id="scim-delete-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="disable">Disable the account (keeps its history)</SelectItem>
                <SelectItem value="delete">Delete the account</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Role of new SCIM users" htmlFor="scim-default-role" hint="Only the group mappings below grant another role.">
            <Select value={form.defaultRole} onValueChange={(value) => set("defaultRole", value as SettingsForm["defaultRole"])} disabled={!editable || pending}>
              <SelectTrigger id="scim-default-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Link on a claim (optional)"
            htmlFor="scim-claim"
            hint={<>The sign-in claim (for a SAML provider, the attribute name) that must equal the user&apos;s SCIM externalId, e.g. <code>sub</code> for Okta or <code>oid</code> for Entra ID.</>}
          >
            <Input id="scim-claim" value={form.externalIdClaim} placeholder="sub" maxLength={64} onChange={(event) => set("externalIdClaim", event.target.value)} disabled={!editable || pending} />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="scim-verified" className="flex flex-col items-start gap-1">
            <span>Require a verified e-mail to link</span>
            <span className="text-xs font-normal text-muted-foreground">
              Without a claim above, the first sign-in links only when the provider reports the address as verified (email_verified).
            </span>
          </Label>
          <Switch id="scim-verified" checked={form.requireVerifiedEmail} onCheckedChange={(checked) => set("requireVerifiedEmail", checked)} disabled={!editable || pending} />
        </div>

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="scim-manage-roles" className="flex flex-col items-start gap-1">
            <span>Manage roles with the group mappings</span>
            <span className="text-xs font-normal text-muted-foreground">
              SCIM users get the role of their first mapped group, or the default role. Role changes made by hand are overwritten.
            </span>
          </Label>
          <Switch id="scim-manage-roles" checked={form.manageRoles} onCheckedChange={(checked) => set("manageRoles", checked)} disabled={!editable || pending} />
        </div>

        {provider?.autoLink && (
          <Banner tone="warn">
            This provider has Auto-link accounts on, so it links to any account with the same e-mail address, not only SCIM users.
          </Banner>
        )}
        {error && <Banner tone="bad" live>{error}</Banner>}
        {canWrite && (
          <div className="flex gap-2">
            <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        )}
    </SectionCard>
  );
}

function TokensCard({ tokens, canWrite }: { tokens: ScimTokenView[]; canWrite: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ScimTokenView | null>(null);

  function create() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await callApi<ScimTokenView & { token: string }>("/api/v1/scim/tokens", "POST", {
          name,
          expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
        });
        setOpen(false);
        setCreated(result.token);
        setName("");
        setExpiresAt("");
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function revoke() {
    const token = revoking;
    if (!token) return;
    startTransition(async () => {
      try {
        await callApi(`/api/v1/scim/tokens/${token.id}`, "DELETE");
        toast.success("Token revoked");
      } catch (err) {
        toast.error((err as Error).message);
      }
      setRevoking(null);
      router.refresh();
    });
  }

  return (
    <SectionCard
      title="SCIM tokens"
      count={tokens.length}
      actions={canWrite ? (
        <Button size="sm" variant="outline" onClick={() => { setError(null); setOpen(true); }}>
          <Plus /> New token
        </Button>
      ) : undefined}
    >
        {tokens.length === 0 ? (
          <EmptyState compact icon={KeyRound} title="No SCIM token yet" description="Create one and paste it into your identity provider." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                {canWrite && <TableHead className="text-right">Revoke</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">{token.name}</TableCell>
                  <TableCell className="num text-xs">{token.prefix}…</TableCell>
                  <TableCell>{formatDate(token.createdAt)}</TableCell>
                  <TableCell>{formatDate(token.lastUsedAt)}</TableCell>
                  <TableCell>
                    {token.expiresAt ? formatDate(token.expiresAt) : "Never"}
                    {token.expired && <Badge variant="warning" className="ml-2">Expired</Badge>}
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon-sm" className="text-bad hover:text-bad" title="Revoke" aria-label={`Revoke ${token.name}`} onClick={() => setRevoking(token)} disabled={pending}>
                        <Trash2 />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

      <AppDialog open={open} onClose={() => setOpen(false)} title="New SCIM token" submitLabel="Create" onSubmit={create} isSubmitting={pending} maxWidth="md">
        <div className="flex flex-col gap-4">
          {error && <Banner tone="bad" live>{error}</Banner>}
          <p className="text-sm text-muted-foreground">
            Anyone with this token can create users and change SCIM users and groups. Store it only in your identity provider.
          </p>
          <Field label="Name" htmlFor="scim-token-name">
            <Input id="scim-token-name" value={name} maxLength={100} placeholder="Microsoft Entra ID" onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Expires (optional)" htmlFor="scim-token-expires" hint="Entra ID and Okta keep using the token until you replace it.">
            <Input id="scim-token-expires" type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          </Field>
        </div>
      </AppDialog>

      <AppDialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Copy the SCIM token now"
        maxWidth="md"
        actions={<Button onClick={() => setCreated(null)}>Done</Button>}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">It is shown only once. Paste it as the secret token in your identity provider.</p>
          <div className="flex gap-2">
            <Input readOnly value={created ?? ""} className="num text-xs" data-testid="scim-new-token" />
            <Button
              variant="outline"
              size="icon"
              title="Copy"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created ?? "");
                  toast.success("Copied");
                } catch {
                  toast.error("Could not copy");
                }
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </AppDialog>

      <AppDialog open={revoking !== null} onClose={() => setRevoking(null)} title={`Revoke "${revoking?.name ?? ""}"?`} submitLabel="Revoke" onSubmit={revoke} isSubmitting={pending}>
        <p className="text-sm text-muted-foreground">The identity provider using it can no longer provision users until you give it a new token.</p>
      </AppDialog>
    </SectionCard>
  );
}

export default function ScimClient(props: ScimClientProps) {
  const { settings } = props;
  const { productName } = useBranding();
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Users and sign-in", props.canReadSignIn === false ? "Sign-in and directories" : { label: "Sign-in and directories", href: "/sign-in" }, "SCIM provisioning"]}
        title="SCIM provisioning"
        description={`Let your identity provider create, update and disable ${productName} users and groups.`}
      />

      <div className="grid gap-5 xl:grid-cols-2">
        <SettingsCard settings={settings} canWrite={props.canWrite} />
        <TokensCard tokens={props.tokens} canWrite={props.canWrite} />
      </div>

      <ScimDirectoryCards {...props} />
    </div>
  );
}

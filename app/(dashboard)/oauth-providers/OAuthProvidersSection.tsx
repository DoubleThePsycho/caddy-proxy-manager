"use client";

import { useState, useCallback } from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Switch } from "@/components/ui/switch";
import {
  oauthCallbackUrl,
  withOAuthClientSecretRotation,
  type OAuthProviderView,
} from "@/src/lib/oauth-provider-view";
import {
  createOAuthProviderAction,
  updateOAuthProviderAction,
  deleteOAuthProviderAction,
} from "../settings/actions";

interface OAuthProvidersSectionProps {
  initialProviders: OAuthProviderView[];
  baseUrl: string;
}

type FormData = {
  name: string;
  type: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  autoLink: boolean;
};

const emptyForm: FormData = {
  name: "",
  type: "oidc",
  clientId: "",
  clientSecret: "",
  issuer: "",
  authorizationUrl: "",
  tokenUrl: "",
  userinfoUrl: "",
  scopes: "openid email profile",
  autoLink: false,
};

export default function OAuthProvidersSection({ initialProviders, baseUrl }: OAuthProvidersSectionProps) {
  const [providers, setProviders] = useState(initialProviders);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<OAuthProviderView | null>(null);
  const [rotateClientSecret, setRotateClientSecret] = useState(false);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const callbackUrl = useCallback(
    (providerId: string) => oauthCallbackUrl(baseUrl, providerId),
    [baseUrl]
  );

  function closeDialog() {
    // Clear any newly-entered replacement secret from client memory as soon
    // as the dialog closes.
    setDialogOpen(false);
    setEditingProvider(null);
    setRotateClientSecret(false);
    setForm(emptyForm);
    setError(null);
  }

  function openAddDialog() {
    setEditingProvider(null);
    setRotateClientSecret(true);
    setForm(emptyForm);
    setError(null);
    setDialogOpen(true);
  }

  function openEditDialog(provider: OAuthProviderView) {
    setEditingProvider(provider);
    setRotateClientSecret(false);
    setForm({
      name: provider.name,
      type: provider.type,
      clientId: provider.clientId,
      clientSecret: "",
      issuer: provider.issuer ?? "",
      authorizationUrl: provider.authorizationUrl ?? "",
      tokenUrl: provider.tokenUrl ?? "",
      userinfoUrl: provider.userinfoUrl ?? "",
      scopes: provider.scopes,
      autoLink: provider.autoLink,
    });
    setError(null);
    setDialogOpen(true);
  }

  async function handleSave() {
    const secretRequired = !editingProvider || rotateClientSecret || !editingProvider.hasClientSecret;
    if (!form.name.trim() || !form.clientId.trim() || (secretRequired && !form.clientSecret.trim())) {
      setError("Name, Client ID, and Client Secret are required.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (editingProvider) {
        const update = withOAuthClientSecretRotation({
          name: form.name.trim(),
          type: form.type,
          clientId: form.clientId.trim(),
          issuer: form.issuer.trim() || null,
          authorizationUrl: form.authorizationUrl.trim() || null,
          tokenUrl: form.tokenUrl.trim() || null,
          userinfoUrl: form.userinfoUrl.trim() || null,
          scopes: form.scopes.trim() || "openid email profile",
          autoLink: form.autoLink,
        }, secretRequired ? form.clientSecret : undefined);
        const updated = await updateOAuthProviderAction(editingProvider.id, update);
        if (updated) {
          setProviders((prev) =>
            prev.map((p) => (p.id === editingProvider.id ? updated : p))
          );
        }
      } else {
        const created = await createOAuthProviderAction({
          name: form.name.trim(),
          type: form.type,
          clientId: form.clientId.trim(),
          clientSecret: form.clientSecret.trim(),
          issuer: form.issuer.trim() || undefined,
          authorizationUrl: form.authorizationUrl.trim() || undefined,
          tokenUrl: form.tokenUrl.trim() || undefined,
          userinfoUrl: form.userinfoUrl.trim() || undefined,
          scopes: form.scopes.trim() || undefined,
          autoLink: form.autoLink,
        });
        setProviders((prev) => [...prev, created]);
      }
      closeDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleEnabled(provider: OAuthProviderView) {
    try {
      const updated = await updateOAuthProviderAction(provider.id, {
        enabled: !provider.enabled,
      });
      if (updated) {
        setProviders((prev) =>
          prev.map((p) => (p.id === provider.id ? updated : p))
        );
      }
    } catch (err) {
      console.error("Failed to toggle provider:", err);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteOAuthProviderAction(id);
      setProviders((prev) => prev.filter((p) => p.id !== id));
      setDeleteConfirmId(null);
    } catch (err) {
      console.error("Failed to delete provider:", err);
    }
  }

  function copyToClipboard(text: string, providerId: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(providerId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  function updateField<K extends keyof FormData>(field: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  return (
    <SectionCard
      title="Providers"
      count={providers.length}
      headingLevel={2}
      actions={
        providers.length > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={openAddDialog}>
            <Plus /> Add provider
          </Button>
        ) : undefined
      }
    >
      {providers.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          title="No OAuth provider yet"
          action={
            <Button type="button" variant="outline" size="sm" onClick={openAddDialog}>
              <Plus /> Add provider
            </Button>
          }
        />
      ) : (
        <ul className="m-0 list-none divide-y divide-line p-0">
          {providers.map((provider) => (
            <li key={provider.id} data-testid="oauth-provider" className="flex flex-col gap-2 px-5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusDot tone={provider.enabled ? "ok" : "off"} srLabel={provider.enabled ? "Enabled" : "Disabled"} />
                  <p className="m-0 font-semibold">{provider.name}</p>
                  <Badge variant="muted">{provider.type.toUpperCase()}</Badge>
                  <Badge variant={provider.source === "env" ? "info" : "secondary"}>
                    {provider.source === "env" ? "ENV" : "UI"}
                  </Badge>
                  {!provider.enabled && <Badge variant="warning">Disabled</Badge>}
                  {provider.autoLink && <span className="text-xs text-soft">Links accounts automatically</span>}
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor={`toggle-${provider.id}`} className="text-xs text-muted-foreground">
                      Enabled
                    </Label>
                    <Switch
                      id={`toggle-${provider.id}`}
                      checked={provider.enabled}
                      onCheckedChange={() => handleToggleEnabled(provider)}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={() => openEditDialog(provider)}
                    disabled={provider.source === "env"}
                    aria-label={`Edit ${provider.name}`}
                    title={provider.source === "env" ? "Environment-sourced providers cannot be edited" : "Edit provider"}
                  >
                    <Pencil />
                  </Button>
                  {deleteConfirmId === provider.id ? (
                    <div className="flex items-center gap-1">
                      <Button variant="danger" size="sm" onClick={() => handleDelete(provider.id)}>
                        Confirm
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setDeleteConfirmId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="danger"
                      size="icon-sm"
                      onClick={() => setDeleteConfirmId(provider.id)}
                      disabled={provider.source === "env"}
                      aria-label={`Delete ${provider.name}`}
                      title={provider.source === "env" ? "Environment-sourced providers cannot be deleted" : "Delete provider"}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-soft">Callback URL</span>
                <code className="num text-xs text-muted-foreground break-all">{callbackUrl(provider.id)}</code>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6 shrink-0"
                  onClick={() => copyToClipboard(callbackUrl(provider.id), provider.id)}
                  aria-label="Copy callback URL"
                  title="Copy callback URL"
                >
                  <Copy className="!size-3" />
                </Button>
                {copiedId === provider.id && (
                  <span role="status" className="text-xs text-ok">
                    Copied
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add / Edit Dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (open) setDialogOpen(true);
          else closeDialog();
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {editingProvider ? "Edit OAuth provider" : "Add an OAuth provider"}
            </DialogTitle>
          </DialogHeader>

          {error && (
            <Banner tone="bad" live>
              {error}
            </Banner>
          )}

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-name">Name *</Label>
              <Input
                id="oauth-name"
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="e.g. Google, Keycloak"
                
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-type">Type</Label>
              <Select
                value={form.type}
                onValueChange={(v) => updateField("type", v)}
              >
                <SelectTrigger id="oauth-type" >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="oidc">OIDC (OpenID Connect)</SelectItem>
                  <SelectItem value="oauth2">OAuth2</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-client-id">Client ID *</Label>
              <Input
                id="oauth-client-id"
                value={form.clientId}
                onChange={(e) => updateField("clientId", e.target.value)}
                className="num"
              />
            </div>

            {editingProvider?.hasClientSecret && !rotateClientSecret ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                <div>
                  <Label>Client secret</Label>
                  <p className="text-xs text-muted-foreground">
                    A secret is configured. Its existing value cannot be viewed.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRotateClientSecret(true)}
                >
                  Rotate secret
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="oauth-client-secret">
                    {editingProvider ? "New client secret *" : "Client secret *"}
                  </Label>
                  {editingProvider?.hasClientSecret && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRotateClientSecret(false);
                        updateField("clientSecret", "");
                      }}
                    >
                      Keep existing
                    </Button>
                  )}
                </div>
                <Input
                  id="oauth-client-secret"
                  type="password"
                  autoComplete="new-password"
                  value={form.clientSecret}
                  onChange={(e) => updateField("clientSecret", e.target.value)}
                  
                />
                {editingProvider && (
                  <p className="text-xs text-muted-foreground">
                    Saving this field replaces the stored secret.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-issuer">Issuer URL</Label>
              <Input
                id="oauth-issuer"
                value={form.issuer}
                onChange={(e) => updateField("issuer", e.target.value)}
                placeholder="https://accounts.google.com"
                className="num"
              />
              <p className="text-xs text-muted-foreground">For OIDC, the endpoints below are discovered from it.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-auth-url">Authorization URL</Label>
              <Input
                id="oauth-auth-url"
                value={form.authorizationUrl}
                onChange={(e) => updateField("authorizationUrl", e.target.value)}
                placeholder="Override discovered endpoint"
                className="num"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-token-url">Token URL</Label>
              <Input
                id="oauth-token-url"
                value={form.tokenUrl}
                onChange={(e) => updateField("tokenUrl", e.target.value)}
                placeholder="Override discovered endpoint"
                className="num"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-userinfo-url">Userinfo URL</Label>
              <Input
                id="oauth-userinfo-url"
                value={form.userinfoUrl}
                onChange={(e) => updateField("userinfoUrl", e.target.value)}
                placeholder="Override discovered endpoint"
                className="num"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-scopes">Scopes</Label>
              <Input
                id="oauth-scopes"
                value={form.scopes}
                onChange={(e) => updateField("scopes", e.target.value)}
                placeholder="openid email profile"
                className="num"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Switch
                id="oauth-auto-link"
                checked={form.autoLink}
                onCheckedChange={(v) => updateField("autoLink", v)}
              />
              <Label htmlFor="oauth-auto-link">
                Auto-link accounts
              </Label>
            </div>
            <p className="text-xs text-muted-foreground -mt-1">
              Links a sign-in to the existing user with the same e-mail address, verified or not. Only for providers where users
              cannot set an address they do not own.
            </p>

            {editingProvider && (
              <div className="flex flex-col gap-1.5 pt-1">
                <Label className="text-xs text-muted-foreground">Callback URL</Label>
                <div className="flex items-center gap-2">
                  <code className="num text-xs text-muted-foreground break-all">
                    {callbackUrl(editingProvider.id)}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 shrink-0"
                    onClick={() => copyToClipboard(callbackUrl(editingProvider.id), editingProvider.id)}
                    title="Copy callback URL"
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : editingProvider ? "Update provider" : "Create provider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

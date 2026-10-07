// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ImageUp, RotateCcw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { Banner } from "@/components/ui/Banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AppDialog } from "@/components/ui/AppDialog";
import { cn } from "@/lib/utils";
import { accentContrastProblem, accentPalette, contrastRatio, formatRatio, normalizeHexColor } from "../colors";
import {
  ASSET_KINDS,
  ASSET_LABELS,
  ASSET_SLUGS,
  IMAGE_TYPE_LABELS,
  TEXT_LIMITS,
  type AccentPalette,
  type AssetKind,
  type BrandingView,
  type PublicBranding,
} from "../types";
import { BrandLogo } from "./BrandParts";

type Result = { ok: true; view: BrandingView } | { ok: false; error: string };

type Props = {
  view: BrandingView;
  canWrite: boolean;
  isSlave: boolean;
  save: (input: Record<string, unknown>) => Promise<Result>;
  upload: (asset: string, form: FormData) => Promise<Result>;
  removeAsset: (asset: string) => Promise<Result>;
  reset: () => Promise<Result>;
};

type Form = {
  productName: string;
  loginHeading: string;
  loginFooter: string;
  accentColor: string;
  accentColorDark: string;
  supportUrl: string;
  supportEmail: string;
  emailSenderName: string;
  showPoweredBy: boolean;
};

function formFrom(view: BrandingView): Form {
  const s = view.settings;
  return {
    productName: s.productName ?? "",
    loginHeading: s.loginHeading ?? "",
    loginFooter: s.loginFooter ?? "",
    accentColor: s.accentColor ?? "",
    accentColorDark: s.accentColorDark ?? "",
    supportUrl: s.supportUrl ?? "",
    supportEmail: s.supportEmail ?? "",
    emailSenderName: s.emailSenderName ?? "",
    showPoweredBy: s.showPoweredBy,
  };
}

/** The colours the theme uses without an accent of your own (app/globals.css). */
const DEFAULT_ACCENT = {
  light: { color: "#5240d6", foreground: "#ffffff" },
  dark: { color: "#5b49dc", foreground: "#ffffff" },
};

type ColorCheck = { color: string | null; problem: string | null };

function checkColor(value: string, theme: "light" | "dark"): ColorCheck {
  if (!value.trim()) return { color: null, problem: null };
  const color = normalizeHexColor(value);
  if (!color) return { color: null, problem: "Use a hex colour such as #1d4ed8" };
  return { color, problem: accentContrastProblem(color, theme) };
}

function ColorField({
  id,
  label,
  hint,
  value,
  check,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  check: ColorCheck;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-lg border border-line2 bg-transparent p-1 disabled:cursor-not-allowed"
          value={check.color ?? "#000000"}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
        <Input id={id} value={value} placeholder="Default" onChange={(event) => onChange(event.target.value)} disabled={disabled} className="num" />
      </div>
      <p className={cn("m-0 text-xs", check.problem ? "text-bad" : "text-soft")}>{check.problem ?? hint}</p>
    </div>
  );
}

/**
 * The sign-in page in one theme. The panel carries the theme's class, so the
 * design tokens inside it are that theme's whatever the dashboard shows;
 * only the accent comes from the form.
 */
function PreviewPanel({ theme, branding, accent }: { theme: "light" | "dark"; branding: PublicBranding; accent: { color: string; foreground: string } }) {
  const logo = theme === "dark" ? branding.logoDarkUrl : branding.logoLightUrl;
  return (
    <div className={cn(theme, "rounded-xl border border-line bg-background p-4 text-foreground")} data-testid={`branding-preview-${theme}`}>
      <p className="mb-2 mt-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-soft">{theme === "dark" ? "Dark theme" : "Light theme"}</p>
      <div className="mx-auto flex max-w-xs flex-col gap-3 rounded-xl border border-line2 bg-panel p-4">
        {logo && <img src={logo} alt="" className="mx-auto max-h-10 max-w-[180px] object-contain" />}
        <p className="m-0 break-words text-center text-lg font-bold">{branding.loginHeading}</p>
        <p className="m-0 text-center text-xs text-muted-foreground">Sign in to your account</p>
        <div className="h-8 rounded-lg border border-line2 bg-background" />
        <div className="h-8 rounded-lg border border-line2 bg-background" />
        <div className="flex h-8 items-center justify-center rounded-lg text-sm font-semibold" style={{ background: accent.color, color: accent.foreground }}>
          Sign in
        </div>
        <p className="m-0 text-center text-xs font-medium" style={{ color: accent.color }}>A link in the accent colour</p>
      </div>
      <div className="mt-3 flex flex-col items-center gap-1 text-center text-xs text-muted-foreground">
        {branding.loginFooter && <p className="m-0 whitespace-pre-line">{branding.loginFooter}</p>}
        {(branding.supportUrl || branding.supportEmail) && (
          <p className="m-0 underline underline-offset-4">
            {[branding.supportUrl ? "Help and support" : null, branding.supportEmail].filter(Boolean).join(" · ")}
          </p>
        )}
        {branding.poweredBy && <p className="m-0 text-[11px]">Powered by {branding.poweredBy.name}</p>}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

export default function BrandingClient({ view: initialView, canWrite, isSlave, save, upload, removeAsset, reset }: Props) {
  const router = useRouter();
  const [view, setView] = useState(initialView);
  const [form, setForm] = useState<Form>(() => formFrom(initialView));
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputs = useRef<Partial<Record<AssetKind, HTMLInputElement | null>>>({});
  const editable = canWrite;

  const light = checkColor(form.accentColor, "light");
  const dark = checkColor(form.accentColorDark, "dark");
  const palette: AccentPalette | null = light.color && !light.problem ? accentPalette(light.color, dark.problem ? null : dark.color) : null;

  const preview: PublicBranding = useMemo(() => {
    const productName = form.productName.trim() || view.defaultProductName;
    const logoLight = view.assets.logoLight?.url ?? view.assets.logoDark?.url ?? null;
    const logoDark = view.assets.logoDark?.url ?? view.assets.logoLight?.url ?? null;
    const custom = productName !== view.defaultProductName || logoLight !== null;
    return {
      productName,
      loginHeading: form.loginHeading.trim() || productName,
      loginFooter: form.loginFooter.trim() || null,
      supportUrl: form.supportUrl.trim() || null,
      supportEmail: form.supportEmail.trim() || null,
      logoLightUrl: logoLight,
      logoDarkUrl: logoDark,
      faviconUrl: view.assets.favicon?.url ?? null,
      poweredBy: form.showPoweredBy && custom ? { name: view.defaultProductName, url: "#" } : null,
    };
  }, [form, view]);

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  /** Images change on their own: an upload or removal keeps unsaved edits in the form. */
  function settle(result: Result, message: string, { keepForm = false } = {}) {
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setView(result.view);
    if (!keepForm) setForm(formFrom(result.view));
    toast.success(message);
    router.refresh();
  }

  function onSave() {
    setError(null);
    startTransition(async () => {
      settle(
        await save({
          productName: form.productName,
          loginHeading: form.loginHeading,
          loginFooter: form.loginFooter,
          accentColor: form.accentColor,
          accentColorDark: form.accentColorDark,
          supportUrl: form.supportUrl,
          supportEmail: form.supportEmail,
          emailSenderName: form.emailSenderName,
          showPoweredBy: form.showPoweredBy,
        }),
        "Branding saved"
      );
    });
  }

  function onUpload(kind: AssetKind, file: File | undefined) {
    if (!file) return;
    const data = new FormData();
    data.set("file", file);
    startTransition(async () => {
      settle(await upload(ASSET_SLUGS[kind], data), `${ASSET_LABELS[kind]} uploaded`, { keepForm: true });
      const input = fileInputs.current[kind];
      if (input) input.value = "";
    });
  }

  function onRemove(kind: AssetKind) {
    startTransition(async () => settle(await removeAsset(ASSET_SLUGS[kind]), `${ASSET_LABELS[kind]} removed`, { keepForm: true }));
  }

  function onReset() {
    startTransition(async () => {
      settle(await reset(), "Branding reset to the defaults");
      setConfirmReset(false);
    });
  }

  const hasCustomBranding = view.source === "local";
  const dirty = JSON.stringify(form) !== JSON.stringify(formFrom(view));

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Settings", "Branding"]}
        title="Branding"
      />

      {isSlave && (
        <Banner tone="info">
          {view.source === "master"
            ? "This instance shows the branding of the master it syncs from. Saving here replaces it on this instance only; resetting brings the master's back."
            : view.source === "local"
              ? "This instance has branding of its own, which replaces the master's. Reset it to show the master's branding again."
              : "This instance syncs its branding from the master, which has none set."}
        </Banner>
      )}
      {error && (
        <Banner tone="bad" live>
          {error}
        </Banner>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-5">
        <div className="flex min-w-0 flex-col gap-5 xl:col-span-3">
          <SectionCard
            title="Name and sign-in pages"
            descriptionPlacement="below"
            description={<>Legal notices keep the name {view.defaultProductName}.</>}
            actions={view.source !== "default" ? <Badge variant="success">Custom</Badge> : <Badge variant="muted">Default</Badge>}
            padded
          >
            <fieldset disabled={!editable || pending} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="brand-product-name">Product name</Label>
                <Input
                  id="brand-product-name"
                  value={form.productName}
                  maxLength={TEXT_LIMITS.productName}
                  placeholder={view.defaultProductName}
                  onChange={(event) => update("productName", event.target.value)}
                />
                <p className="m-0 text-xs text-soft">Page titles, the dashboard, the sign-in pages, e-mails and authenticator apps.</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="brand-login-heading">Sign-in heading</Label>
                <Input
                  id="brand-login-heading"
                  value={form.loginHeading}
                  maxLength={TEXT_LIMITS.loginHeading}
                  placeholder={form.productName.trim() || view.defaultProductName}
                  onChange={(event) => update("loginHeading", event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="brand-login-footer">Sign-in footer</Label>
                <Textarea
                  id="brand-login-footer"
                  rows={3}
                  value={form.loginFooter}
                  maxLength={TEXT_LIMITS.loginFooter}
                  placeholder="For example: Managed by Example IT. Unauthorised access is prohibited."
                  onChange={(event) => update("loginFooter", event.target.value)}
                />
                <p className="m-0 text-xs text-soft">Plain text under the sign-in forms; line breaks are kept.</p>
              </div>
              <label className="flex items-center gap-2.5 text-sm">
                <Switch checked={form.showPoweredBy} onCheckedChange={(checked) => update("showPoweredBy", checked)} />
                Show a small &quot;Powered by {view.defaultProductName}&quot; note
              </label>
            </fieldset>
          </SectionCard>

          <SectionCard
            title="Accent colour"
            descriptionPlacement="below"
            description="Buttons, links and highlights. Each colour needs 3:1 contrast with its theme's background."
            padded
          >
            <fieldset disabled={!editable || pending} className="m-0 grid min-w-0 gap-4 border-0 p-0 sm:grid-cols-2">
              <ColorField
                id="brand-accent"
                label="Light theme"
                hint={palette ? `Text on it: ${palette.light.foreground === "#ffffff" ? "white" : "black"}, ${formatRatio(contrastRatio(palette.light.color, palette.light.foreground))}` : "Empty: the default purple"}
                value={form.accentColor}
                check={light}
                disabled={!editable || pending}
                onChange={(value) => update("accentColor", value)}
              />
              <ColorField
                id="brand-accent-dark"
                label="Dark theme"
                hint={palette ? `Empty: derived from the light colour (${palette.dark.color})` : "Set the light theme's colour first"}
                value={form.accentColorDark}
                check={dark}
                disabled={!editable || pending || !light.color}
                onChange={(value) => update("accentColorDark", value)}
              />
            </fieldset>
          </SectionCard>

          <SectionCard
            title="Logos and favicon"
            descriptionPlacement="below"
            description={
              <>
                PNG, JPEG or WebP logos up to <span className="num">2048×2048</span> and a PNG or ICO favicon up to{" "}
                <span className="num">512×512</span>, at most <span className="num">{formatBytes(view.limits.maxBytes)}</span> each; no SVG.
                A single logo is used in both themes.
              </>
            }
          >
            <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
              {ASSET_KINDS.map((kind) => {
                const asset = view.assets[kind];
                const types = view.limits.assets[kind].types;
                return (
                  <li key={kind} className="flex flex-wrap items-center gap-4 px-[18px] py-3" data-testid={`branding-asset-${ASSET_SLUGS[kind]}`}>
                    {/* The swatch takes the theme the image is for, whatever the dashboard shows. */}
                    <div
                      className={cn(
                        kind === "logoDark" ? "dark" : "light",
                        "flex h-14 w-24 shrink-0 items-center justify-center rounded-lg border border-line2 bg-background"
                      )}
                    >
                      {asset ? (
                        <img src={asset.url} alt={ASSET_LABELS[kind]} className="max-h-12 max-w-[88px] object-contain" />
                      ) : (
                        <ImageUp aria-hidden="true" className="h-5 w-5 text-soft" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-sm font-medium">{ASSET_LABELS[kind]}</p>
                      <p className="m-0 text-xs text-soft">
                        {asset ? (
                          <>
                            {IMAGE_TYPE_LABELS[asset.type]}, <span className="num">{asset.width}×{asset.height}</span>,{" "}
                            <span className="num">{formatBytes(asset.bytes)}</span>
                          </>
                        ) : (
                          `Not set; ${types.map((type) => IMAGE_TYPE_LABELS[type]).join(", ")}`
                        )}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <input
                        ref={(element) => { fileInputs.current[kind] = element; }}
                        type="file"
                        className="hidden"
                        accept={types.join(",")}
                        aria-label={`Upload ${ASSET_LABELS[kind].toLowerCase()}`}
                        onChange={(event) => onUpload(kind, event.target.files?.[0])}
                      />
                      <Button variant="outline" size="sm" disabled={!editable || pending} onClick={() => fileInputs.current[kind]?.click()}>
                        <ImageUp aria-hidden="true" /> {asset ? "Replace" : "Upload"}
                      </Button>
                      {asset && (
                        <Button variant="danger" size="sm" disabled={!canWrite || pending} onClick={() => onRemove(kind)}>
                          <Trash2 aria-hidden="true" /> Remove
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </SectionCard>

          <SectionCard title="Support and e-mail" padded>
            <fieldset disabled={!editable || pending} className="m-0 grid min-w-0 gap-4 border-0 p-0 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="brand-support-url">Support URL</Label>
                <Input id="brand-support-url" type="url" value={form.supportUrl} placeholder="https://support.example.com" onChange={(event) => update("supportUrl", event.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="brand-support-email">Support e-mail</Label>
                <Input id="brand-support-email" type="email" value={form.supportEmail} placeholder="help@example.com" onChange={(event) => update("supportEmail", event.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="brand-sender-name">E-mail sender name</Label>
                <Input
                  id="brand-sender-name"
                  value={form.emailSenderName}
                  maxLength={TEXT_LIMITS.emailSenderName}
                  placeholder="Empty: the bare sender address"
                  onChange={(event) => update("emailSenderName", event.target.value)}
                />
                <p className="m-0 text-xs text-soft">The From name of alert and digest e-mails.</p>
              </div>
            </fieldset>
          </SectionCard>

          <div
            className={cn(
              "flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border px-4 py-3",
              dirty && editable ? "border-brand bg-brand-tint" : "border-line bg-panel"
            )}
          >
            <span role="status" className="flex min-w-0 flex-[1_1_240px] items-center gap-2 text-[13px] text-muted-foreground">
              <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", dirty && editable ? "bg-primary" : "bg-ok")} />
              {!editable ? "Read-only" : dirty ? "Unsaved changes" : "No unsaved changes"}
            </span>
            {hasCustomBranding && (
              <Button variant="ghost" onClick={() => setConfirmReset(true)} disabled={!canWrite || pending}>
                <RotateCcw aria-hidden="true" /> Reset to defaults
              </Button>
            )}
            {editable && (
              <Button variant="outline" onClick={() => setForm(formFrom(view))} disabled={!dirty || pending}>
                Discard
              </Button>
            )}
            <Button onClick={onSave} disabled={!editable || pending}>Save</Button>
          </div>
        </div>

        <div className="min-w-0 xl:sticky xl:top-6 xl:col-span-2">
          <SectionCard title="Preview" padded contentClassName="flex flex-col gap-4">
            <PreviewPanel theme="light" branding={preview} accent={palette?.light ?? DEFAULT_ACCENT.light} />
            <PreviewPanel theme="dark" branding={preview} accent={palette?.dark ?? DEFAULT_ACCENT.dark} />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Dashboard sidebar:</span>
              {preview.logoLightUrl ? (
                <BrandLogo branding={preview} className="h-6 w-auto max-w-[80px]" />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground">
                  {Array.from(preview.productName)[0]}
                </span>
              )}
              <span className="truncate font-semibold text-foreground">{preview.productName}</span>
            </div>
          </SectionCard>
        </div>
      </div>

      <AppDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset the branding?"
        submitLabel="Reset"
        onSubmit={onReset}
        isSubmitting={pending}
      >
        <p className="text-sm text-muted-foreground">
          The product name, texts, colours, logos and favicon go back to the defaults on this instance
          {isSlave ? ", and the master's branding applies again" : ""}.
        </p>
      </AppDialog>
    </div>
  );
}

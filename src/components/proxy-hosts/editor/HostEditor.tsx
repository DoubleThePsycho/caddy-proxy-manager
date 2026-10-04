"use client";

/**
 * The sectioned host editor (/proxy-hosts/new and /proxy-hosts/[id]/edit):
 * a section list (Routing, Security, Access, Certificate, Headers, Advanced,
 * each linkable as #routing …), the settings of the chosen section, and a
 * bar at the bottom that counts unsaved changes against the saved host and
 * opens a review of exactly what will change, the approval policy that
 * applies and the impact, before the change is saved or submitted.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Switch } from "@/components/ui/switch";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { policiesCovering } from "@/ee/approvals/match";
import { previewProxyHostEditorAction, saveProxyHostEditorAction } from "@/app/(dashboard)/proxy-hosts/editor-actions";
import { changeGroups, formChanges, isSectionId, SECTION_LABELS, SECTIONS, type ChangeLookup, type FormChange, type SectionId } from "./changes";
import { EditorProvider, type EditorContextValue } from "./fields";
import { buildPayload, copyHostForm, hostToForm, LB_POLICIES, newHostForm, payloadIsEmpty, serializeUpstreams, type HostForm } from "./model";
import { fieldOfServerError, validateForm, type FieldErrors } from "./validate";
import { ReviewPanel, type PreviewState } from "./ReviewPanel";
import { RoutingSection } from "./RoutingSection";
import { SecuritySection } from "./SecuritySection";
import { AccessSection } from "./AccessSection";
import { AdvancedSection, CertificateSection, HeadersSection } from "./OtherSections";
import type { HostEditorData } from "./types";

const SECTION_ICONS: Record<SectionId, string> = {
  routing: "M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4",
  security: "M12 3L5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6zM9 12l2 2 4-4",
  access: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  certificate: "M12 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM8.5 13.5L7 22l5-3 5 3-1.5-8.5",
  headers: "M4 6h16M4 12h10M4 18h7",
  advanced: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
};

/** Cards that can be linked to directly (#waf), and the section they are in. */
const CARD_SECTIONS: Record<string, SectionId> = {
  domains: "routing",
  upstreams: "routing",
  "load-balancing": "routing",
  protocols: "routing",
  "f-routes": "routing",
  waf: "security",
  "f-waf-exclusions": "security",
  "rate-limiting": "security",
  "access-list": "access",
  "geo-blocking": "access",
  "sign-in": "access",
  "f-mtls": "access",
  "f-blocks": "access",
  hsts: "headers",
  "f-redirects": "advanced",
  "f-error-pages": "advanced",
  "name-resolution": "advanced",
  "raw-json": "advanced",
};

const WAF_LABELS = { inherit: "global mode", off: "off", detection_only: "detect only", block: "block" } as const;
const GLOBAL_WAF = { On: "blocking", DetectionOnly: "detection only", Off: "off" } as const;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function sectionSummary(section: SectionId, form: HostForm, data: HostEditorData): string {
  switch (section) {
    case "routing": {
      const upstreams = serializeUpstreams(form.upstreams).length;
      const policy = form.lb.enabled ? LB_POLICIES.find((entry) => entry.value === form.lb.policy)?.label.toLowerCase() : "random";
      return `${plural(form.domains.length, "domain")} · ${plural(upstreams, "upstream")} · ${policy}`;
    }
    case "security": {
      const rate = form.rateLimit.enabled ? plural(form.rateLimit.rules.length, "rate limit") : "no own rate limits";
      return `WAF ${WAF_LABELS[form.waf.mode]} · ${rate}`;
    }
    case "access": {
      const parts = [
        form.accessListId !== null ? data.accessLists.find((list) => list.id === form.accessListId)?.name ?? "Access list" : null,
        form.geoblock.enabled ? "Geo blocking" : null,
        form.signIn === "authentik" ? "Authentik" : form.signIn === "generic" ? "Forward auth" : form.signIn === "ingressi" ? "Sign-in" : null,
        form.mtls.enabled ? "mTLS" : null,
        form.pathBlocks.length > 0 ? plural(form.pathBlocks.length, "blocked path") : null,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(" · ") : "Public";
    }
    case "certificate": {
      if (form.certificateId === null) {
        const served = data.host?.certificateId === null ? data.servedCertificate : null;
        if (served) return `Managed by Caddy · ${Math.max(0, Math.floor((new Date(served.validTo).getTime() - Date.now()) / 86_400_000))} days left`;
        return "Managed by Caddy";
      }
      return data.certificates.find((certificate) => certificate.id === form.certificateId)?.name ?? "Chosen certificate";
    }
    case "headers":
      return `HSTS ${form.hstsEnabled ? "on" : "off"}`;
    case "advanced": {
      const parts = [
        form.redirects.length > 0 ? plural(form.redirects.length, "redirect") : null,
        form.pathRewrites.length > 0 || form.rewritePrefix.trim() ? "rewrites" : null,
        form.errorPages.length > 0 ? plural(form.errorPages.length, "error page") : null,
        form.dnsResolver.enabled ? "own resolvers" : null,
        form.customPreHandlersJson.trim() || form.customReverseProxyJson.trim() ? "raw JSON" : null,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(" · ") : "Nothing extra";
    }
  }
}

type Done =
  | { kind: "saved"; title: string; text: string; href: string; link: string }
  | { kind: "submitted"; title: string; text: string; href: string; link: string };

function initialForm(data: HostEditorData): HostForm {
  const context = {
    authentikDefaults: data.authentikDefaults,
    forwardAuthDefaults: data.forwardAuthDefaults,
    forwardAuthAccess: data.forwardAuthAccess,
    globalCrs: data.wafGlobal?.loadOwaspCrs,
  };
  if (data.host) return hostToForm(data.host, context);
  if (data.template) {
    const form = copyHostForm(data.template, { canSetCustomJson: data.isAdmin, canChooseTrust: data.canChooseTrust }, context);
    if (data.initialDomain) form.domains = [data.initialDomain];
    return form;
  }
  return newHostForm({ initialDomain: data.initialDomain, scopeTags: data.scopeTags }, context);
}

const noSubscription = () => () => {};

export function HostEditor({ data }: { data: HostEditorData }) {
  const router = useRouter();
  const format = useFormat();
  // False in the server render and during hydration, true once React owns
  // the fields: text typed into them before that is reset by hydration.
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  const creating = data.mode === "create";
  const base = data.host ?? data.template;
  const [saved, setSaved] = useState<HostForm>(() => initialForm(data));
  const [form, setForm] = useState<HostForm>(saved);
  const [section, setSection] = useState<SectionId>("routing");
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const [note, setNote] = useState("");
  const [emergency, setEmergency] = useState(false);
  const [emergencyReason, setEmergencyReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const pendingFocus = useRef<string | null>(null);
  // Bumped to focus pendingFocus after the next render, even when the section stays the same.
  const [focusTick, setFocusTick] = useState(0);
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const previewRun = useRef(0);

  const groups = useMemo(() => changeGroups(data.mode), [data.mode]);
  const lookup = useMemo<ChangeLookup>(
    () => ({
      certificate: (id) => data.certificates.find((certificate) => certificate.id === id)?.name ?? `Certificate #${id}`,
      accessList: (id) => data.accessLists.find((list) => list.id === id)?.name ?? `Access list #${id}`,
      user: (id) => data.users.find((user) => user.id === id)?.name ?? `#${id}`,
      group: (id) => data.groups.find((group) => group.id === id)?.name ?? `#${id}`,
      role: (id) => data.mtlsRoles.find((role) => role.id === id)?.name ?? `#${id}`,
      clientCertificate: (id) => data.clientCertificates.find((certificate) => certificate.id === id)?.commonName ?? `#${id}`,
      globalWafMode: data.wafGlobal ? GLOBAL_WAF[data.wafGlobal.mode] : "blocking",
    }),
    [data]
  );

  const changes = useMemo(() => formChanges(saved, form, lookup, groups), [saved, form, lookup, groups]);
  const payload = useMemo(() => buildPayload(form, saved, base, creating), [form, saved, base, creating]);
  const dirty = creating || !payloadIsEmpty(payload);
  const nameSection: SectionId = creating ? "routing" : "advanced";
  const validation = useMemo(
    () => validateForm(form, { nameSection, dnsProviderConfigured: data.dnsProviderConfigured, canChooseTrust: data.canChooseTrust }),
    [form, nameSection, data.dnsProviderConfigured, data.canChooseTrust]
  );
  const visibleErrors = useMemo(() => {
    const out: FieldErrors = { ...serverErrors };
    for (const [id, error] of Object.entries(validation)) {
      if (showAllErrors || touched.has(id) || (id.startsWith("f-up-") && touched.has("f-up-0"))) out[id] = error;
    }
    return out;
  }, [serverErrors, validation, showAllErrors, touched]);
  const errorCount = Object.keys(validation).length + Object.keys(serverErrors).length;

  // Policies that cover this host (before and after a tag change), for the header and the bar.
  const covering = useMemo(() => {
    if (!data.approval || data.approval.policies.length === 0) return [];
    const tags = [...new Set([...saved.tags, ...form.tags])];
    return policiesCovering(data.approval.policies, "proxy_host", tags, [creating ? "create" : "update"]);
  }, [data.approval, saved.tags, form.tags, creating]);

  const update = useCallback((recipe: (current: HostForm) => HostForm) => {
    setForm((current) => recipe(current));
    setDone(null);
    setSubmitError(null);
    setServerErrors({});
  }, []);

  const touch = useCallback((id: string) => {
    setTouched((current) => (current.has(id) ? current : new Set([...current, id])));
  }, []);

  const wasOf = useCallback(
    (groupId: string) => {
      const change = changes.find((entry) => entry.group.id === groupId);
      if (!change || creating || change.group.kind !== "value") return null;
      return change.group.lines(saved, lookup)[0] ?? null;
    },
    [changes, creating, saved, lookup]
  );

  // Sections are linkable: #routing, #security … (or a card id inside one), and ?section=routing ….
  const selectFromHash = useCallback(() => {
    const hash = decodeURIComponent(window.location.hash.replace(/^#/, "")) || new URLSearchParams(window.location.search).get("section") || "";
    if (!hash) return;
    if (isSectionId(hash)) {
      setSection(hash);
      return;
    }
    const owner = CARD_SECTIONS[hash];
    if (owner) {
      setSection(owner);
      pendingFocus.current = hash;
      setFocusTick((tick) => tick + 1);
    }
  }, []);

  useEffect(() => {
    selectFromHash();
    window.addEventListener("hashchange", selectFromHash);
    return () => window.removeEventListener("hashchange", selectFromHash);
  }, [selectFromHash]);

  // Drop the old deep links' leftovers (?create=1, ?edit=<id>) and ?section= (now the #anchor) from the address bar.
  useEffect(() => {
    const url = new URL(window.location.href);
    const section = url.searchParams.get("section");
    if (!["create", "edit", "section"].some((key) => url.searchParams.has(key))) return;
    for (const key of ["create", "edit", "section"]) url.searchParams.delete(key);
    if (section && !url.hash && (isSectionId(section) || CARD_SECTIONS[section])) url.hash = section;
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);

  // Focus the field a "Show" or an error link points at, once its section has rendered.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.focus({ preventScroll: true });
    }
  }, [section, focusTick]);

  const goToSection = useCallback((next: SectionId, focusId?: string) => {
    setSection(next);
    window.history.replaceState(window.history.state, "", `#${next}`);
    pendingFocus.current = focusId ?? null;
    if (focusId) setFocusTick((tick) => tick + 1);
    else requestAnimationFrame(() => sectionHeading.current?.focus());
  }, []);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty || done || (creating && changes.length === 0)) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, done, creating, changes.length]);

  // The review's preview: re-run whenever what would be sent changes while it is open.
  const payloadKey = JSON.stringify(payload);
  useEffect(() => {
    if (!reviewOpen) return;
    const run = ++previewRun.current;
    setPreview({ status: "loading" });
    previewProxyHostEditorAction(data.host?.id ?? null, payload)
      .then((result) => {
        if (run !== previewRun.current) return;
        if (result.status === "ok") setPreview({ status: "ready", preview: result.preview });
        else setPreview({ status: "error", message: result.message });
      })
      .catch(() => run === previewRun.current && setPreview({ status: "error", message: "The change could not be checked: the server did not answer." }));
    // payloadKey stands for payload: the preview re-runs only when what would be sent changes.
  }, [reviewOpen, payloadKey, data.host?.id]);

  const firstError = useCallback((): { id: string; section: SectionId } | null => {
    const entries = Object.entries({ ...validation, ...serverErrors });
    if (entries.length === 0) return null;
    entries.sort(([, a], [, b]) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section));
    return { id: entries[0][0], section: entries[0][1].section };
  }, [validation, serverErrors]);

  const openReview = useCallback(() => {
    if (Object.keys(validation).length > 0) {
      setShowAllErrors(true);
      const first = firstError();
      setAnnouncement(`Fix ${plural(Object.keys(validation).length, "problem")} before saving.`);
      if (first) goToSection(first.section, first.id);
      return;
    }
    setSubmitError(null);
    setReviewOpen(true);
  }, [validation, firstError, goToSection]);

  const closeReview = useCallback(() => {
    setReviewOpen(false);
    requestAnimationFrame(() => reviewButton.current?.focus());
  }, []);

  // Ctrl/Cmd+S opens the review.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && !reviewOpen) openReview();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, reviewOpen, openReview]);

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    const result = await saveProxyHostEditorAction(data.host?.id ?? null, {
      ...payload,
      ...(emergency ? { emergencyReason: emergencyReason.trim() } : note.trim() ? { note: note.trim() } : {}),
    }).catch(() => ({ status: "error" as const, message: "The server did not answer. Nothing was saved." }));
    setSubmitting(false);
    if (result.status === "error") {
      const field = fieldOfServerError(result.message, nameSection);
      if (field) {
        setServerErrors({ [field.id]: { message: result.message, section: field.section } });
        setReviewOpen(false);
        setAnnouncement(`Not saved: ${result.message}`);
        goToSection(field.section, field.id);
      } else {
        setSubmitError(result.message);
      }
      return;
    }
    setReviewOpen(false);
    setEmergency(false);
    setEmergencyReason("");
    setNote("");
    if (result.status === "saved") {
      if (creating) {
        setAnnouncement(result.message);
        setSaved(form);
        router.push(`/proxy-hosts/${result.hostId}`);
        return;
      }
      setSaved(form);
      setDone({ kind: "saved", title: "Saved", text: `${result.message} Caddy has the new configuration.`, href: `/proxy-hosts/${result.hostId}`, link: "Open host" });
      setAnnouncement(result.message);
      router.refresh();
      return;
    }
    if (result.requestStatus === "applied") {
      if (!creating) setSaved(form);
      setDone({
        kind: "saved",
        title: "Applied as an emergency change",
        text: "Caddy has the new configuration. The audit log records the change with your reason.",
        href: "/audit-log",
        link: "Open the audit log",
      });
      setAnnouncement("Applied as an emergency change.");
      router.refresh();
      return;
    }
    setDone({ kind: "submitted", title: "Change request submitted for approval", text: result.message, href: "/approvals", link: "Open in Approvals" });
    setAnnouncement(result.message);
  }

  const context: EditorContextValue = { form, saved, data, lookup, update, errors: visibleErrors, touch, wasOf };
  const hostName = data.host?.name ?? (form.name.trim() || "the new host");
  const perSection = new Map<SectionId, number>();
  for (const change of changes) perSection.set(change.group.section, (perSection.get(change.group.section) ?? 0) + 1);
  const errorsPerSection = new Map<SectionId, number>();
  for (const error of Object.values(visibleErrors)) errorsPerSection.set(error.section, (errorsPerSection.get(error.section) ?? 0) + 1);

  const ready = preview.status === "ready" ? preview.preview : null;
  const submitLabel = emergency
    ? "Apply now as an emergency change"
    : ready?.approval.required
      ? "Submit for approval"
      : creating
        ? "Create host"
        : "Save changes";
  const closeHref = data.host ? `/proxy-hosts/${data.host.id}` : "/proxy-hosts";
  const confirmLeave = (event: MouseEvent) => {
    if (dirty && !done && !(creating && changes.length === 0) && !window.confirm("Leave the editor? Your unsaved changes are lost.")) event.preventDefault();
  };

  const sections: Record<SectionId, ReactNode> = {
    routing: <RoutingSection />,
    security: <SecuritySection />,
    access: <AccessSection />,
    certificate: <CertificateSection />,
    headers: <HeadersSection />,
    advanced: <AdvancedSection />,
  };

  const count = changes.length;
  const barTitle = creating ? (count > 0 ? `New host · ${plural(count, "setting")} set` : "New host") : count === 0 ? "No unsaved changes" : plural(count, "unsaved change");
  const barText = creating
    ? covering.length > 0
      ? "Creating it sends a change request for approval."
      : "Review the settings, then create it."
    : count === 0
      ? "Everything matches the saved host."
      : covering.length > 0
        ? "Saving sends them for approval."
        : "Saving applies them at once.";

  return (
    <EditorProvider value={context}>
      <div className="flex flex-col gap-5 pb-36 md:pb-28">
        <PageHeader
          className="mb-0"
          breadcrumb={
            data.host
              ? [{ label: "Proxy hosts", href: "/proxy-hosts" }, { label: data.host.name, href: `/proxy-hosts/${data.host.id}` }, "Edit"]
              : [{ label: "Proxy hosts", href: "/proxy-hosts" }, "New host"]
          }
          title={data.host ? `Edit ${data.host.name}` : data.template ? `Copy of ${data.template.name}` : "New proxy host"}
          actions={
            <>
              <span className="flex h-[38px] items-center gap-2.5 rounded-[10px] border border-line bg-panel px-3 text-[13px]">
                <span className="flex flex-col leading-4">
                  <span id="f-enabled-label" className="font-semibold">
                    {form.enabled ? "Enabled" : "Paused"}
                  </span>
                  <span className="text-xs text-soft">{form.enabled ? "Routing traffic" : "Not answering requests"}</span>
                </span>
                <Switch id="f-enabled" aria-label="Host enabled" checked={form.enabled} onCheckedChange={(enabled) => update((f) => ({ ...f, enabled }))} />
              </span>
              <Button asChild variant="outline" className="h-[38px]">
                <Link href={closeHref} onClick={confirmLeave}>
                  Close editor
                </Link>
              </Button>
            </>
          }
        >
          {(covering.length > 0 || form.tags.length > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              {covering.length > 0 && (
                <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-line2 px-2.5 text-xs text-muted-foreground">
                  <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5 text-warn" />
                  {covering[0].name}
                  {covering.length > 1 ? ` and ${covering.length - 1} more` : ""} {covering.length > 1 ? "policies" : "policy"} · changes need approval
                </span>
              )}
              {form.tags.map((tag) => (
                <span key={tag} className="num rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </PageHeader>

        {data.template && (
          <Banner tone="info" title={`A copy of ${data.template.name}.`}>
            Change the domains before creating it: two hosts cannot serve the same name.
            {!data.isAdmin && (data.template.customPreHandlersJson || data.template.customReverseProxyJson) ? " Custom Caddy JSON was not copied: only administrators set it." : ""}
            {!data.canChooseTrust && data.template.mtls?.enabled ? " Client certificate settings were not copied: your role cannot choose them." : ""}
          </Banner>
        )}

        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-6">
          <nav aria-label="Host settings" className="lg:w-[240px] lg:shrink-0">
            <ul className="m-0 flex list-none gap-1 overflow-x-auto p-0 pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
              {SECTIONS.map((id) => {
                const current = section === id;
                const changed = perSection.get(id) ?? 0;
                const problems = errorsPerSection.get(id) ?? 0;
                return (
                  <li key={id} className="shrink-0">
                    <a
                      href={`#${id}`}
                      aria-current={current ? "true" : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        goToSection(id);
                      }}
                      className={cn(
                        "flex items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left no-underline transition-colors",
                        current ? "bg-brand-tint text-foreground" : "text-muted-foreground hover:bg-panel2 hover:text-foreground"
                      )}
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24" className="mt-px h-[18px] w-[18px] shrink-0 fill-none stroke-current" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                        <path d={SECTION_ICONS[id]} />
                      </svg>
                      <span className="flex min-w-0 flex-col gap-px">
                        <span className={cn("flex items-center gap-2 whitespace-nowrap", current ? "font-semibold" : "font-medium")}>
                          {SECTION_LABELS[id]}
                          {changed > 0 && <span className="num rounded-full bg-brand-tint px-1.5 text-[11px] font-semibold leading-[18px] text-brand">{plural(changed, "change")}</span>}
                          {problems > 0 && <span className="num rounded-full bg-bad-tint px-1.5 text-[11px] font-semibold leading-[18px] text-bad">{plural(problems, "problem")}</span>}
                        </span>
                        <span className="hidden max-w-[200px] truncate text-xs leading-4 text-soft lg:block">{sectionSummary(id, form, data)}</span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
            {data.lastSaved && (
              <div className="mt-3 hidden flex-col gap-1 border-t border-line px-2.5 pt-3 text-xs text-soft lg:flex">
                <span>
                  Last saved{" "}
                  <time dateTime={data.lastSaved.at} suppressHydrationWarning>
                    {format.dateTime(data.lastSaved.at)}
                  </time>
                  {data.lastSaved.by && (
                    <>
                      {" "}
                      by <span className="text-muted-foreground">{data.lastSaved.by}</span>
                    </>
                  )}
                </span>
                {data.historyHref && (
                  <Link href={data.historyHref} className="text-brand no-underline hover:underline">
                    History of this host
                  </Link>
                )}
              </div>
            )}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-5" id="host-editor-section">
            <h2 ref={sectionHeading} tabIndex={-1} className="sr-only">
              {SECTION_LABELS[section]}
            </h2>
            {sections[section]}
          </div>
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="fixed inset-x-3 bottom-[calc(68px_+_env(safe-area-inset-bottom))] z-30 flex flex-col gap-2 md:bottom-4 md:left-[calc(15.5rem_+_max(2rem,_(100vw_-_15.5rem_-_1600px)_/_2_+_2rem))] md:right-[max(2rem,_calc((100vw_-_15.5rem_-_1600px)_/_2_+_2rem))]">
        {reviewOpen && (
          <ReviewPanel
            title={creating ? `Review the new host ${hostName}` : `Review ${plural(count, "change")} to ${hostName}`}
            changes={changes}
            creating={creating}
            preview={preview}
            note={note}
            onNote={setNote}
            emergency={emergency}
            onEmergency={setEmergency}
            emergencyReason={emergencyReason}
            onEmergencyReason={setEmergencyReason}
            submitError={submitError}
            submitting={submitting}
            submitLabel={submitLabel}
            onSubmit={submit}
            onClose={closeReview}
            onShow={(change: FormChange) => {
              setReviewOpen(false);
              goToSection(change.group.section, change.group.focus);
            }}
            onUndo={(change: FormChange) => setForm((current) => change.group.restore(current, saved))}
            hostLabel={hostName}
          />
        )}
        <div
          data-testid="host-editor-bar"
          data-hydrated={hydrated ? "true" : undefined}
          className={cn("flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-2xl border bg-panel px-4 py-3 shadow-overlay", count > 0 || creating ? "border-line2" : "border-line")}
        >
          {done ? (
            <>
              <span className="flex min-w-0 flex-[1_1_320px] items-start gap-2.5">
                <CheckCircle2 aria-hidden="true" className={cn("mt-px h-[18px] w-[18px] shrink-0", done.kind === "saved" ? "text-ok" : "text-warn")} />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">{done.title}</span>
                  <span className="text-[13px] text-muted-foreground">{done.text}</span>
                </span>
              </span>
              <span className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" onClick={() => setDone(null)}>
                  Keep editing
                </Button>
                <Button asChild variant="secondary">
                  <Link href={done.href}>{done.link}</Link>
                </Button>
              </span>
            </>
          ) : (
            <>
              <span className="flex min-w-0 flex-[1_1_260px] items-center gap-2.5">
                <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", errorCount > 0 && showAllErrors ? "bg-bad" : count > 0 || creating ? "bg-brand" : "bg-ok")} />
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold">{barTitle}</span>
                  <span className="text-[13px] text-soft">
                    {showAllErrors && errorCount > 0 ? (
                      <button
                        type="button"
                        className="text-bad underline-offset-4 hover:underline"
                        onClick={() => {
                          const first = firstError();
                          if (first) goToSection(first.section, first.id);
                        }}
                      >
                        {plural(errorCount, "problem")} to fix before saving. Show the first
                      </button>
                    ) : (
                      barText
                    )}
                  </span>
                </span>
              </span>
              <span className="flex flex-wrap gap-2">
                {!creating && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={count === 0 && payloadIsEmpty(payload)}
                    onClick={() => {
                      setForm(saved);
                      setServerErrors({});
                      setShowAllErrors(false);
                      setReviewOpen(false);
                      setAnnouncement("Changes discarded.");
                    }}
                  >
                    Discard
                  </Button>
                )}
                <Button
                  ref={reviewButton}
                  type="button"
                  variant="secondary"
                  aria-expanded={reviewOpen}
                  disabled={!dirty}
                  onClick={() => (reviewOpen ? closeReview() : openReview())}
                >
                  {creating ? "Review" : "Review changes"}
                </Button>
                {!reviewOpen && (
                  <Button type="button" disabled={!dirty} onClick={openReview}>
                    {creating ? "Create host" : "Save"}
                  </Button>
                )}
              </span>
            </>
          )}
        </div>
      </div>
    </EditorProvider>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  Award,
  BarChart3,
  Database,
  FileWarning,
  Gauge,
  Globe,
  History,
  KeyRound,
  Lock,
  Palette,
  Pin,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  UserCheck,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { cn } from "@/lib/utils";
import {
  SETTINGS_SECTION_ALIASES,
  SETTINGS_SECTION_GROUPS,
  resolveSettingsSection,
  type SettingsSection,
} from "@/src/lib/settings-sections";
import OAuthProvidersSection from "./OAuthProvidersSection";
import UsagePingSection from "./UsagePingSection";
import GeneralGroup from "./groups/GeneralGroup";
import CertificatesGroup from "./groups/CertificatesGroup";
import SyncGroup, { MODE_LABELS } from "./groups/SyncGroup";
import { TrustedProxiesGroup, UpstreamDnsGroup } from "./groups/NetworkingGroups";
import { ErrorPagesGroup, ForwardAuthGroup, GeoGroup, RateLimitGroup } from "./groups/SecurityGroups";
import AnalyticsGroup from "./groups/AnalyticsGroup";
import { BackupsGroup } from "@/ee/backups/ui/BackupsSummaryGroup";
import { BrandingGroup } from "@/ee/white-label/ui/BrandingSummaryGroup";
import { RestrictedNotice } from "@/src/components/settings/RestrictedNotice";
import ClusterSection, { clusterSummaryLabel } from "@/ee/high-availability/ui/ClusterSection";
import SharedStateSection from "@/ee/high-availability/ui/SharedStateSection";
import { removeSharedStateAction, saveSharedStateAction, sharedStateStatusAction } from "@/ee/high-availability/ui/shared-state-actions";
import type { AnalyticsStatusView, BackupsSummaryView, BrandingSummaryView, SettingsClientProps } from "./types";

// The dialogs of the instance sync group, rendered on their own by tests.
export { EditSlaveInstanceForm, RemovePinnedSlaveConfirmation, SyncKeyPinDialogBody } from "./groups/SyncGroup";

const GROUP_ICONS: Record<string, LucideIcon> = {
  general: SlidersHorizontal,
  acme: Award,
  sync: RefreshCw,
  "high-availability": Server,
  backups: Database,
  "usage-ping": BarChart3,
  "trusted-proxies": Waypoints,
  "upstream-dns": Pin,
  geoblock: Globe,
  "rate-limit": Gauge,
  "error-pages": FileWarning,
  "forward-auth": UserCheck,
  oauth: KeyRound,
  analytics: Activity,
  branding: Palette,
};

const DEFAULT_GROUP = "general";

const DEFAULT_ANALYTICS: AnalyticsStatusView = { enabled: false, retentionDays: 30, retentionFromEnv: false, totals: null, totalsError: null };
const DEFAULT_BACKUPS: BackupsSummaryView = { allowed: false, configurable: false, editionLabel: "Business", destinations: [] };
const DEFAULT_BRANDING: BrandingSummaryView = { licensed: false, canRead: false, editionLabel: "MSP" };

type GroupItem = SettingsSection & { section: string };

const ALL_GROUPS: readonly GroupItem[] = SETTINGS_SECTION_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, section: group.label }))
);

/** Words a group is found by: its name, description, keywords and the cards it took in. */
const SEARCH_TEXT: Record<string, string> = Object.fromEntries(
  ALL_GROUPS.map((group) => {
    const aliases = SETTINGS_SECTION_ALIASES.filter((alias) => alias.section === group.id);
    const text = [group.name, group.desc, ...group.keywords, ...aliases.flatMap((alias) => [alias.name, ...alias.keywords])];
    return [group.id, text.join(" ").toLowerCase()];
  })
);

function matches(groupId: string, words: string[]): boolean {
  return words.every((word) => SEARCH_TEXT[groupId]?.includes(word));
}

function resolveInitial(id: string | null | undefined): { group: string; anchor: string | null } {
  const resolved = id ? resolveSettingsSection(id) : null;
  return resolved ? { group: resolved.section.id, anchor: resolved.anchor } : { group: DEFAULT_GROUP, anchor: null };
}

function scheduleMeta(backups: BackupsSummaryView): string {
  if (!backups.allowed) return "";
  const active = backups.destinations.find((destination) => destination.enabled);
  if (active) return active.schedule.kind.charAt(0).toUpperCase() + active.schedule.kind.slice(1);
  return backups.destinations.length > 0 ? "Paused" : "Off";
}

export default function SettingsClient(props: SettingsClientProps) {
  const {
    general,
    acme,
    dnsProvider,
    dnsProviderDefinitions,
    authentik,
    forwardAuth,
    metrics,
    logging,
    dns,
    upstreamDnsResolution,
    trustedProxies,
    defaultResponse,
    globalGeoBlock,
    globalErrorPages,
    globalRateLimit,
    oauthProviders,
    baseUrl,
    usagePing,
    canWriteSettings,
    canWriteInstances = canWriteSettings,
    initialSection,
    restricted,
    certificateStorage,
    cluster,
    instanceSync,
    geoip = [],
    analytics = DEFAULT_ANALYTICS,
    backups = DEFAULT_BACKUPS,
    branding = DEFAULT_BRANDING,
    links = { history: false, certificates: false, fleet: false },
  } = props;

  const initial = resolveInitial(initialSection);
  const [active, setActive] = useState(initial.group);
  const [anchor, setAnchor] = useState<string | null>(initial.anchor);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([initial.group]));
  const [dirty, setDirty] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");

  const open = useCallback((group: string, target: string | null = null) => {
    setActive(group);
    setAnchor(target);
    setVisited((previous) => (previous.has(group) ? previous : new Set([...previous, group])));
  }, []);

  // Follow ?section= while mounted: the command palette navigates here with another group.
  const sectionParam = useSearchParams()?.get("section") ?? null;
  const [followedSection, setFollowedSection] = useState(sectionParam);
  if (sectionParam !== followedSection) {
    setFollowedSection(sectionParam);
    const resolved = sectionParam ? resolveSettingsSection(sectionParam) : null;
    if (resolved) open(resolved.section.id, resolved.anchor);
  }

  const selectGroup = (id: string) => {
    open(id);
    try {
      window.history.replaceState(null, "", `${window.location.pathname}?section=${encodeURIComponent(id)}`);
    } catch {
      // The address bar is a convenience; the group is already shown.
    }
  };

  // An old section id opens its group scrolled to the card it became.
  useEffect(() => {
    if (!anchor) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [anchor, active]);

  const anyDirty = Object.values(dirty).some((count) => count > 0);
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const reporters = useMemo(() => {
    const entries = ALL_GROUPS.map((group) => [
      group.id,
      (count: number) => setDirty((previous) => (previous[group.id] === count ? previous : { ...previous, [group.id]: count })),
    ]);
    return Object.fromEntries(entries) as Record<string, (count: number) => void>;
  }, []);

  const isSlave = instanceSync.mode === "slave";
  const overrides = instanceSync.overrides;

  const meta: Record<string, string> = {
    sync: restricted?.sync ? "" : MODE_LABELS[instanceSync.mode],
    "high-availability": cluster ? clusterSummaryLabel(cluster.view) : "",
    backups: scheduleMeta(backups),
    "usage-ping": usagePing.enabled ? "On" : "Off",
    analytics: analytics.enabled ? `${analytics.retentionDays} days` : "Off",
    branding: branding.licensed ? "" : branding.editionLabel,
  };

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shownGroups = SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => matches(item.id, words)),
  })).filter((group) => group.items.length > 0);
  const found = shownGroups.reduce((total, group) => total + group.items.length, 0);

  const current = ALL_GROUPS.find((group) => group.id === active) ?? ALL_GROUPS[0];

  function renderGroup(id: string): ReactNode {
    switch (id) {
      case "general":
        return (
          <GeneralGroup
            general={general}
            defaultResponse={defaultResponse}
            baseUrl={baseUrl}
            isSlave={isSlave}
            overrides={overrides}
            canSave={canWriteSettings}
            onDirtyChange={reporters.general}
          />
        );
      case "acme":
        return (
          <CertificatesGroup
            acme={acme}
            general={general}
            dnsProvider={dnsProvider}
            dnsProviderDefinitions={dnsProviderDefinitions}
            dns={dns}
            isSlave={isSlave}
            overrides={overrides}
            certificateStorage={certificateStorage ?? null}
            storageRestricted={Boolean(restricted?.certificateStorage)}
            canSave={canWriteSettings}
            canOpenCertificates={links.certificates}
            onDirtyChange={reporters.acme}
          />
        );
      case "sync":
        return restricted?.sync ? (
          <SectionCard title="Instance sync" headingLevel={3} padded>
            <RestrictedNotice permission="instances:read" />
          </SectionCard>
        ) : (
          <SyncGroup instanceSync={instanceSync} canSave={canWriteInstances} canOpenFleet={links.fleet} onDirtyChange={reporters.sync} />
        );
      case "high-availability":
        return (
          <div className="flex flex-col gap-4">
            {restricted?.certificateStorage || !cluster ? (
              <SectionCard title="Dashboard cluster" headingLevel={3} padded>
                <RestrictedNotice permission="high_availability:read" />
              </SectionCard>
            ) : (
              <ClusterSection view={cluster.view} editionLabel={cluster.editionLabel} />
            )}
            {!restricted?.certificateStorage && certificateStorage?.sharedState && (
              <div id="settings-shared-state" className="scroll-mt-4">
                <SharedStateSection
                  view={certificateStorage.sharedState}
                  canWrite={certificateStorage.canWrite}
                  editionLabel={certificateStorage.editionLabel}
                  save={saveSharedStateAction}
                  remove={removeSharedStateAction}
                  loadStatus={sharedStateStatusAction}
                />
              </div>
            )}
          </div>
        );
      case "backups":
        return <BackupsGroup backups={backups} />;
      case "usage-ping":
        return <UsagePingSection initial={usagePing} canWrite={canWriteSettings} />;
      case "trusted-proxies":
        return (
          <TrustedProxiesGroup
            trustedProxies={trustedProxies}
            isSlave={isSlave}
            override={overrides.trustedProxies}
            canSave={canWriteSettings}
            onDirtyChange={reporters["trusted-proxies"]}
          />
        );
      case "upstream-dns":
        return (
          <UpstreamDnsGroup
            upstreamDnsResolution={upstreamDnsResolution}
            isSlave={isSlave}
            override={overrides.upstreamDnsResolution}
            canSave={canWriteSettings}
            onDirtyChange={reporters["upstream-dns"]}
          />
        );
      case "geoblock":
        return <GeoGroup globalGeoBlock={globalGeoBlock ?? null} geoip={geoip} canSave={canWriteSettings} onDirtyChange={reporters.geoblock} />;
      case "rate-limit":
        return <RateLimitGroup globalRateLimit={globalRateLimit ?? null} canSave={canWriteSettings} onDirtyChange={reporters["rate-limit"]} />;
      case "error-pages":
        return <ErrorPagesGroup globalErrorPages={globalErrorPages ?? null} canSave={canWriteSettings} onDirtyChange={reporters["error-pages"]} />;
      case "forward-auth":
        return (
          <ForwardAuthGroup
            authentik={authentik}
            forwardAuth={forwardAuth}
            isSlave={isSlave}
            overrides={overrides}
            canSave={canWriteSettings}
            onDirtyChange={reporters["forward-auth"]}
          />
        );
      case "oauth":
        return restricted?.oauth ? (
          <SectionCard title="Providers" headingLevel={3} padded>
            <RestrictedNotice permission="sso:read" />
          </SectionCard>
        ) : (
          <OAuthProvidersSection initialProviders={oauthProviders} baseUrl={baseUrl} />
        );
      case "analytics":
        return (
          <AnalyticsGroup
            analytics={analytics}
            logging={logging}
            metrics={metrics}
            isSlave={isSlave}
            overrides={overrides}
            canSave={canWriteSettings}
            onDirtyChange={reporters.analytics}
          />
        );
      case "branding":
        return <BrandingGroup branding={branding} />;
      default:
        return null;
    }
  }

  return (
    <>
      <div className="flex flex-col gap-5">
        <PageHeader
          className="mb-0"
          breadcrumb={["Settings", current.section, current.name]}
          title="Settings"
          description="Defaults for every host and how this install runs. A host's own settings win over these."
          actions={
            links.history ? (
              <Button asChild variant="outline">
                <Link href="/history">
                  <History />
                  Change history
                </Link>
              </Button>
            ) : undefined
          }
        />

        <div className="flex flex-col items-start gap-5 lg:flex-row">
          <aside
            aria-label="Settings navigation"
            className="hidden w-[260px] shrink-0 flex-col gap-3.5 rounded-2xl border border-line bg-panel p-3 lg:flex"
          >
            <div className="relative flex h-9 items-center gap-2 rounded-[10px] border border-line2 bg-background pl-2.5 pr-1.5 text-soft focus-within:border-brand">
              <Search aria-hidden="true" className="h-[15px] w-[15px] shrink-0" />
              <label htmlFor="settings-search" className="sr-only">
                Search settings
              </label>
              <input
                id="settings-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search settings"
                autoComplete="off"
                className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-soft [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-raise hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            {words.length > 0 && (
              <p role="status" className="-mt-1 mx-1 mb-0 text-xs text-soft">
                {found === 0 ? "No matches" : found === 1 ? "1 match" : `${found} matches`}
              </p>
            )}

            <nav aria-label="Settings groups" className="flex flex-col gap-3.5">
              {shownGroups.map((group) => (
                <div key={group.id} className="flex flex-col gap-0.5">
                  <div aria-hidden="true" className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-soft">
                    {group.label}
                  </div>
                  <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={group.label}>
                    {group.items.map((item) => {
                      const Icon = item.id === "branding" && !branding.licensed ? Lock : GROUP_ICONS[item.id] ?? SlidersHorizontal;
                      const isActive = item.id === active;
                      const unsaved = (dirty[item.id] ?? 0) > 0;
                      const itemMeta = unsaved ? "Unsaved" : meta[item.id] ?? "";
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => selectGroup(item.id)}
                            aria-current={isActive ? "true" : undefined}
                            className={cn(
                              "flex min-h-9 w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                              isActive ? "bg-brand-tint font-semibold text-foreground" : "font-medium text-muted-foreground hover:bg-raise hover:text-foreground"
                            )}
                          >
                            <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.8} />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span>{item.name}</span>
                              {words.length > 0 && <span className="text-xs font-normal leading-4 text-soft">{item.desc}</span>}
                            </span>
                            {itemMeta && (
                              <span className={cn("shrink-0 text-xs font-medium", unsaved ? "text-warn" : "text-soft")}>{itemMeta}</span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>

            {found === 0 && (
              <div className="flex flex-col items-start gap-2.5 px-1.5 pb-2">
                <p className="m-0 text-[13px] text-muted-foreground">No setting matches &ldquo;{query.trim()}&rdquo;.</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              </div>
            )}
          </aside>

          <div className="w-full lg:hidden" data-testid="mobile-settings-nav">
            <label htmlFor="settings-group-select" className="mb-1.5 block text-[13px] font-medium">
              Settings group
            </label>
            <select
              id="settings-group-select"
              value={active}
              onChange={(event) => selectGroup(event.target.value)}
              className="h-11 w-full rounded-lg border border-line2 bg-panel px-3 text-base text-foreground md:text-sm"
            >
              {SETTINGS_SECTION_GROUPS.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {(dirty[item.id] ?? 0) > 0 ? " (unsaved)" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="flex w-full min-w-0 flex-1 flex-col">
            {ALL_GROUPS.filter((group) => visited.has(group.id)).map((group) => (
              <section
                key={group.id}
                hidden={group.id !== active}
                aria-labelledby={`settings-group-${group.id}`}
                data-settings-group={group.id}
                className="flex min-w-0 flex-col gap-4"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <h2 id={`settings-group-${group.id}`} className="m-0 text-lg leading-[26px] font-semibold">
                      {group.name}
                    </h2>
                    {group.id === "branding" && !branding.licensed && (
                      <span className="inline-flex h-[22px] items-center rounded-full border border-line2 px-2 text-xs text-muted-foreground">
                        {branding.editionLabel} edition
                      </span>
                    )}
                  </div>
                  <p className="m-0 max-w-[720px] text-[13px] text-muted-foreground [text-wrap:pretty]">{group.desc}</p>
                </div>
                {renderGroup(group.id)}
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

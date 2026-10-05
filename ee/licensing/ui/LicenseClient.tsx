// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, Minus, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BRAND_NAME, BRAND_WEBSITE, documentationUrl } from "@/src/lib/brand";
import type { Feature } from "@/ee/licensing/features";
import type { FeatureUsage } from "@/ee/licensing/usage";
import type { LicenseView } from "@/ee/licensing/view";
import type { LicenseAutoUpdateView } from "@/ee/licensing/auto-update";
import { removeLicenseAction } from "./actions";
import { EditionMatrix } from "./EditionMatrix";
import { InstallKeyCard } from "./InstallKeyCard";
import { AutoUpdateCard } from "./AutoUpdateCard";
import { GRACE_PERIOD_DAYS, daysUntil, featureRows, formatDay, formatDayRange, nextDay, plural, releaseLine } from "./license-format";

export type LicenseClientProps = {
  license: LicenseView;
  /** Which paid features are set up here (ee/licensing/usage.ts). */
  usage?: Partial<Record<Feature, FeatureUsage>>;
  /** The release this install runs (APP_VERSION). */
  version?: string;
  /** Ids of the public keys built into this release. */
  trustedKeyIds?: readonly string[];
  /** The user may install and remove keys (license:write). */
  canWrite?: boolean;
  /** The server's clock, so day counts match between the server and the browser. */
  now?: string;
  /** Automatic updates from the license server (ee/licensing/auto-update.ts); the card is left out without it. */
  autoUpdate?: LicenseAutoUpdateView;
};

type Tone = "ok" | "warn" | "bad" | "off";

const STATUS: Record<LicenseView["status"], { label: string; tone: Tone }> = {
  unlicensed: { label: "No license", tone: "off" },
  active: { label: "Active", tone: "ok" },
  grace: { label: "Grace period", tone: "warn" },
  expired: { label: "Expired", tone: "bad" },
  invalid: { label: "Invalid key", tone: "bad" },
};

const PILL: Record<Tone, { box: string; dot: string }> = {
  ok: { box: "bg-ok-tint text-ok", dot: "bg-ok" },
  warn: { box: "bg-warn-tint text-warn", dot: "bg-warn" },
  bad: { box: "bg-bad-tint text-bad", dot: "bg-bad" },
  off: { box: "bg-raise text-muted-foreground", dot: "bg-soft" },
};

const CARD = "flex min-w-0 flex-col rounded-2xl border border-line bg-panel px-5 pt-[18px] pb-5";
const BIG = "num text-[26px] leading-8 font-medium tracking-[-0.02em]";

function StatusPill({ status }: { status: LicenseView["status"] }) {
  const { label, tone } = STATUS[status];
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold", PILL[tone].box)}>
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", PILL[tone].dot)} />
      {label}
    </span>
  );
}

function Tile({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-line bg-panel2 px-4 py-3.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {value}
      {children}
    </div>
  );
}

function NodesTile({ license }: { license: LicenseView }) {
  const { used, licensed, overLimit } = license.nodes;
  const replicas = Math.max(0, used - 1);
  const share = licensed ? Math.min(100, Math.round((used / licensed) * 100)) : 0;
  return (
    <Tile
      label="Nodes"
      value={
        <span className="flex items-baseline gap-2">
          <span className={BIG}>{used.toLocaleString("en-US")}</span>
          {licensed !== null && (
            <span className="text-[13px] text-muted-foreground">
              of <span className="num">{licensed.toLocaleString("en-US")}</span>
            </span>
          )}
        </span>
      }
    >
      {licensed !== null && (
        <span role="img" aria-label={`${used} of ${licensed} nodes in use`} className="flex h-1.5 overflow-hidden rounded-[3px] bg-raise">
          <span className={overLimit ? "bg-warn" : "bg-ok"} style={{ width: `${Math.max(share, used > 0 ? 3 : 0)}%` }} />
        </span>
      )}
      <span className="text-xs leading-4 text-soft">
        {replicas === 0 ? "This dashboard, with no replicas." : `This dashboard and ${plural(replicas, "replica", "replicas")}.`}
        {licensed !== null && " Going over is never blocked; the difference is invoiced at renewal."}
      </span>
    </Tile>
  );
}

function DaysNote({ days, issuedAt }: { days: number; issuedAt: string | null }) {
  const count = Math.abs(days);
  return (
    <span className="text-xs leading-4 text-soft">
      {days === 0 ? (
        "Today."
      ) : days > 0 ? (
        <>
          In <span className="num">{count.toLocaleString("en-US")}</span> {count === 1 ? "day" : "days"}.
        </>
      ) : (
        <>
          <span className="num">{count.toLocaleString("en-US")}</span> {count === 1 ? "day" : "days"} ago.
        </>
      )}
      {issuedAt && ` Issued ${formatDay(issuedAt)}.`}
    </span>
  );
}

function CurrentLicenseCard({
  license,
  now,
  trustedKeyIds,
  canWrite,
}: {
  license: LicenseView;
  now: string;
  trustedKeyIds: readonly string[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const headingId = useId();
  const confirmTitleId = useId();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const valid = license.status === "active" || license.status === "grace" || license.status === "expired";
  const hasKey = license.status !== "unlicensed";

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  function closeConfirm() {
    setConfirming(false);
    setError(null);
    removeRef.current?.focus();
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      try {
        await removeLicenseAction();
        setConfirming(false);
        router.refresh();
      } catch {
        setError("The key could not be removed. Try again.");
      }
    });
  }

  const days = license.expiresAt ? daysUntil(license.expiresAt, now) : null;
  const keyIds = license.keyId ? [license.keyId] : trustedKeyIds;

  return (
    <section aria-labelledby={headingId} className={cn(CARD, "flex-[2_1_560px] gap-4")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={headingId} className="m-0 text-base leading-6 font-semibold">
          Current license
        </h2>
        <StatusPill status={license.status} />
        {valid && (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line2 px-2.5 text-xs text-muted-foreground">
            <Check aria-hidden="true" className="h-3 w-3" />
            Verified offline
          </span>
        )}
        {license.trial && (
          <span className="inline-flex h-6 items-center rounded-full border border-line2 px-2.5 text-xs text-muted-foreground">Trial</span>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <span className="text-[26px] leading-8 font-semibold tracking-[-0.02em]">
          {valid ? license.editionLabel : license.status === "invalid" ? "No valid license" : "Community"}
        </span>
        {valid ? (
          <span className="text-[13px] text-muted-foreground">
            {license.customer && (
              <>
                Licensed to <span className="text-foreground">{license.customer}</span>
              </>
            )}
            {license.customer && license.licenseId && " · "}
            {license.licenseId && (
              <>
                license <span className="num text-foreground">{license.licenseId}</span>
              </>
            )}
          </span>
        ) : (
          <span className="text-[13px] text-muted-foreground">
            {license.status === "invalid"
              ? "The stored key cannot be used. Every free feature keeps working."
              : "Every free feature works without a license. Paid features can be seen but not set up."}
          </span>
        )}
      </div>

      {license.status === "invalid" && license.error && (
        <Banner tone="bad" title={license.error}>
          Install a valid key, or remove this one.
        </Banner>
      )}
      {license.status === "grace" && license.expiresAt && license.graceEndsAt && (
        <Banner tone="warn" title={`The license expired on ${formatDay(license.expiresAt)}.`}>
          Paid features stay editable until {formatDay(license.graceEndsAt)}, then become read-only. Renew to keep changing them.
        </Banner>
      )}
      {license.status === "expired" && (
        <Banner tone="warn" title="The license has expired.">
          Paid features you set up keep working but can no longer be changed. Renew to edit them again.
        </Banner>
      )}
      {license.nodes.overLimit && license.nodes.licensed !== null && (
        <Banner tone="warn" title={`This dashboard manages ${license.nodes.used} nodes; the license covers ${license.nodes.licensed}.`}>
          Nothing is blocked; the difference is invoiced at renewal.
        </Banner>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(190px,100%),1fr))] gap-3">
        <NodesTile license={license} />
        {valid && license.expiresAt && days !== null && (
          <Tile
            label={days >= 0 ? (license.trial ? "Trial ends" : "Renews") : "Expired"}
            value={<span className={BIG}>{formatDay(license.expiresAt)}</span>}
          >
            <DaysNote days={days} issuedAt={license.issuedAt} />
          </Tile>
        )}
        {valid && license.graceEndsAt && (
          <Tile
            label={license.status === "expired" ? "Read-only since" : "If it is not renewed"}
            value={<span className={BIG}>{formatDay(license.graceEndsAt)}</span>}
          >
            <span className="text-xs leading-4 text-soft">
              {license.status === "expired"
                ? "The grace period is over. Paid features stay read-only until a key is installed; nothing stopped working."
                : `End of the ${GRACE_PERIOD_DAYS}-day grace period. Paid features then turn read-only; nothing stops working.`}
            </span>
          </Tile>
        )}
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-background px-3.5 py-3 text-[13px]">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
        <span>
          <span className="font-semibold">{valid ? "Signature checked on this machine" : "Keys are checked on this machine"}</span>{" "}
          <span className="text-muted-foreground">
            with public key{keyIds.length > 1 ? "s" : ""}{" "}
            {keyIds.map((id, index) => (
              <span key={id}>
                {index > 0 && ", "}
                <span className="num text-foreground">{id}</span>
              </span>
            ))}
            , built into this release. The key is never sent anywhere, so air-gapped installs work the same way.
          </span>
        </span>
      </div>

      {hasKey && canWrite && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <Button
            ref={removeRef}
            type="button"
            variant="danger"
            size="sm"
            aria-expanded={confirming}
            onClick={() => (confirming ? closeConfirm() : setConfirming(true))}
            disabled={pending}
          >
            Remove key
          </Button>
          <span className="flex-[1_1_280px] text-xs text-soft">
            A license only controls setting paid features up. Deleting or turning one off never needs one.
          </span>
        </div>
      )}
      {confirming && (
        <div
          role="alertdialog"
          aria-labelledby={confirmTitleId}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeConfirm();
          }}
          className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-lg border border-line2 bg-bad-tint px-3.5 py-3"
        >
          <span className="min-w-0 flex-[1_1_320px] text-[13px]">
            <span id={confirmTitleId} className="font-semibold">
              Remove the license key?
            </span>{" "}
            Paid features you set up keep running, but cannot be changed until a key is installed again.
            {error && <span className="mt-1 block font-medium text-bad">{error}</span>}
          </span>
          <Button ref={cancelRef} type="button" variant="outline" size="sm" onClick={closeConfirm} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" className="bg-bad font-semibold text-background hover:bg-bad/90" onClick={remove} disabled={pending}>
            {pending ? "Removing…" : "Remove"}
          </Button>
        </div>
      )}
    </section>
  );
}

const BACKPORTED = [
  "Fixes for security vulnerabilities",
  "Fixes for data loss, outages and security regressions",
  "Caddy, Go, Bun and base image updates that fix a vulnerability",
];
const NOT_BACKPORTED = ["New features", "Changes in behaviour", "Database migrations, unless a fix cannot be made without one"];

function ReleaseLineCard({ version, ltsIncluded }: { version: string; ltsIncluded: boolean }) {
  const headingId = useId();
  const { version: running, line } = releaseLine(version);
  return (
    <section aria-labelledby={headingId} className={cn(CARD, "flex-[2_1_560px] gap-3.5")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={headingId} className="m-0 text-base leading-6 font-semibold">
          Release line
        </h2>
        {line && (
          <span className="num inline-flex h-[22px] items-center rounded-full border border-line2 px-2 text-xs text-muted-foreground">{line}</span>
        )}
        <a
          href={documentationUrl("ee/docs/lts.md")}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline"
        >
          Planned long-term support
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
        </a>
      </div>
      <p className="m-0 text-[13px] text-muted-foreground">
        This install runs <span className="num text-foreground">{running}</span>
        {line ? (
          <>
            {" "}
            on the <span className="num text-foreground">{line}</span> line.
          </>
        ) : (
          "."
        )}{" "}
        Long-term-support releases are planned; no long-term-support line has been announced yet. Once one is, one minor release a year will be
        named long-term support in its release notes, and its line will get security and critical fixes for 24 months, and no new features.{" "}
        {ltsIncluded
          ? "Your license will cover the backports and support for running it."
          : "Backports and support for running a long-term-support line will come with an Enterprise license."}
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-3">
        <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
          <h3 className="m-0 text-[13px] font-semibold">To be backported</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
            {BACKPORTED.map((item) => (
              <li key={item} className="flex gap-2">
                <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
          <h3 className="m-0 text-[13px] font-semibold">Not to be backported</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px] text-muted-foreground">
            {NOT_BACKPORTED.map((item) => (
              <li key={item} className="flex gap-2">
                <Minus aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-soft" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <dl className="m-0 flex flex-col">
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line py-2.5">
          <dt className="flex-[0_0_150px] text-[13px] text-muted-foreground">Supported until</dt>
          <dd className="m-0 flex-[1_1_260px] text-[13px]">
            24 months from a long-term-support line&apos;s first release, once one is announced; its release notes will give the date.
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line py-2.5">
          <dt className="flex-[0_0_150px] text-[13px] text-muted-foreground">Stay on the line</dt>
          <dd className="m-0 flex-[1_1_260px] text-[13px]">
            Pin the image tag <span className="num">:{line ?? "<major>.<minor>"}</span>. <span className="num">:latest</span> moves to new
            feature releases.
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line py-2.5">
          <dt className="flex-[0_0_150px] text-[13px] text-muted-foreground">Upgrades</dt>
          <dd className="m-0 flex-[1_1_260px] text-[13px]">Each long-term-support line will upgrade directly from the previous one.</dd>
        </div>
      </dl>
    </section>
  );
}

export type LicensePhase = { when: string; text: string; tone: "ok" | "warn" | "off"; current: boolean };

/** What happens as the license runs out, with the installed key's dates when there is one. */
export function licenseEndPhases(license: LicenseView): LicensePhase[] {
  const status = license.status;
  const dates =
    license.expiresAt && license.graceEndsAt && (status === "active" || status === "grace" || status === "expired")
      ? { expires: license.expiresAt, graceEnds: license.graceEndsAt }
      : null;
  return [
    {
      when: dates ? `Until ${formatDay(dates.expires)}` : "While the license is valid",
      text: "Everything works and can be changed, as today.",
      tone: "ok",
      current: status === "active",
    },
    {
      when: dates ? formatDayRange(nextDay(dates.expires), new Date(dates.graceEnds)) : `For ${GRACE_PERIOD_DAYS} days after it expires`,
      text: "Grace period. Paid features stay editable; renew before it ends.",
      tone: "warn",
      current: status === "grace",
    },
    {
      when: dates ? `From ${formatDay(nextDay(dates.graceEnds))}` : "After the grace period",
      text: "Paid features keep running but are read-only. Deleting or turning one off still works.",
      tone: "off",
      current: status === "expired",
    },
  ];
}

const PHASE_DOT: Record<LicensePhase["tone"], string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  off: "border-2 border-soft",
};

function LicenseEndsCard({ license }: { license: LicenseView }) {
  const headingId = useId();
  const phases = licenseEndPhases(license);
  return (
    <section aria-labelledby={headingId} className={cn(CARD, "flex-[1_1_320px] gap-3.5")}>
      <h2 id={headingId} className="m-0 text-base leading-6 font-semibold">
        If the license ends
      </h2>
      <ol className="m-0 flex list-none flex-col p-0">
        {phases.map((phase, index) => (
          <li key={phase.when} className="flex gap-3" aria-current={phase.current ? "step" : undefined}>
            <span aria-hidden="true" className="flex w-3 flex-none flex-col items-center">
              <span
                className={cn(
                  "mt-[5px] box-border h-2.5 w-2.5 flex-none rounded-full",
                  PHASE_DOT[phase.tone],
                  phase.current && "ring-2 ring-brand ring-offset-2 ring-offset-panel"
                )}
              />
              {index < phases.length - 1 && <span className="w-0.5 flex-1 bg-line2" />}
            </span>
            <span className={cn("flex flex-col gap-0.5", index < phases.length - 1 && "pb-3.5")}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="num text-xs text-soft">{phase.when}</span>
                {phase.current && <span className="text-xs font-semibold text-foreground">Now</span>}
              </span>
              <span className="text-[13px]">{phase.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function LicenseClient({
  license,
  usage = {},
  version = "unknown",
  trustedKeyIds = [],
  canWrite = true,
  now: nowProp,
  autoUpdate,
}: LicenseClientProps) {
  // Fixed for the life of the page, so the server and browser renders agree.
  const [now] = useState(() => nowProp ?? new Date().toISOString());
  const rows = useMemo(() => featureRows(license, usage), [license, usage]);
  const inUse = useMemo(() => rows.filter((row) => row.install === "use").map((row) => row.id), [rows]);
  const valid = license.status === "active" || license.status === "grace" || license.status === "expired";
  const ltsIncluded = license.features.some((feature) => feature.id === "air_gap" && feature.configurable);

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        breadcrumb={["Administration", "License"]}
        title="License"
        description={`Paid features of ${BRAND_NAME} and the key that unlocks them. Traffic, certificates, the WAF and sign-in keep working without one.`}
        className="mb-0"
        actions={
          <Button variant="outline" asChild>
            <a href={`${BRAND_WEBSITE}/pricing`} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />
              {valid ? "Renew or upgrade" : "Get a license or a 14-day trial"}
            </a>
          </Button>
        }
      />

      <div className="flex flex-wrap items-start gap-5">
        <CurrentLicenseCard license={license} now={now} trustedKeyIds={trustedKeyIds} canWrite={canWrite} />
        {canWrite ? (
          <InstallKeyCard hasLicense={license.status !== "unlicensed"} nodesUsed={license.nodes.used} inUse={inUse} />
        ) : (
          <section className={cn(CARD, "flex-[1_1_320px] gap-1")}>
            <h2 className="m-0 text-base leading-6 font-semibold">Install a new key</h2>
            <p className="m-0 text-[13px] text-muted-foreground">
              Your role can see the license but not change it. Someone who may change the license installs and removes keys.
            </p>
          </section>
        )}
      </div>

      {autoUpdate && (
        <div className="flex flex-wrap items-start gap-5">
          <AutoUpdateCard initial={autoUpdate} canWrite={canWrite} installedLicenseId={valid ? license.licenseId : null} />
        </div>
      )}

      <EditionMatrix license={license} rows={rows} />

      <div className="flex flex-wrap items-start gap-5">
        <ReleaseLineCard version={version} ltsIncluded={ltsIncluded} />
        <LicenseEndsCard license={license} />
      </div>
    </div>
  );
}

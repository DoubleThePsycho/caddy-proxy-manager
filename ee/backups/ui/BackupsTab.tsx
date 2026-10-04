// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CloudUpload, Pencil, Plug, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes } from "@/components/ui/chart-format";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import {
  DEFAULT_REGION,
  DEFAULT_RETENTION,
  MAX_RETENTION,
  MIN_RETENTION,
  STORAGE_PRESETS,
  WEEKDAY_LABELS,
  WEEKDAYS,
  describeSchedule,
  type BackupDestinationView,
  type BackupObjectsListing,
  type BackupObjectView,
  type BackupRestoreResult,
  type BackupRunView,
  type BackupRunsPage,
  type BackupTestResult,
  type ScheduleKind,
  type Weekday,
} from "@/ee/backups/types";
import { jsonInit, readError, requestJson } from "@/src/lib/request-json";

const LOCKED_HINT = "Needs a license with Scheduled backups";

type Props = {
  destinations: BackupDestinationView[];
  runs: BackupRunsPage;
  configurable: boolean;
  isSlave: boolean;
  editionLabel: string;
  minPassphraseLength: number;
};

type Form = {
  name: string;
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  passphrase: string;
  passphraseConfirm: string;
  kind: ScheduleKind;
  minute: string;
  time: string;
  day: Weekday;
  timeZone: string;
  retention: string;
};

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function emptyForm(): Form {
  return {
    name: "",
    enabled: true,
    endpoint: "",
    region: DEFAULT_REGION,
    bucket: "",
    prefix: "ingressi",
    pathStyle: false,
    accessKeyId: "",
    secretAccessKey: "",
    passphrase: "",
    passphraseConfirm: "",
    kind: "daily",
    minute: "0",
    time: "03:00",
    day: "sunday",
    timeZone: browserTimeZone(),
    retention: String(DEFAULT_RETENTION),
  };
}

function formFromDestination(destination: BackupDestinationView): Form {
  const schedule = destination.schedule;
  return {
    ...emptyForm(),
    name: destination.name,
    enabled: destination.enabled,
    endpoint: destination.endpoint,
    region: destination.region,
    bucket: destination.bucket,
    prefix: destination.prefix,
    pathStyle: destination.pathStyle,
    accessKeyId: destination.accessKeyId,
    kind: schedule.kind,
    minute: schedule.kind === "hourly" ? String(schedule.minute) : "0",
    time: schedule.kind === "hourly" ? "03:00" : schedule.time,
    day: schedule.kind === "weekly" ? schedule.day : "sunday",
    timeZone: destination.timeZone,
    retention: String(destination.retention),
  };
}

function fileName(key: string | null): string {
  if (!key) return "";
  return key.slice(key.lastIndexOf("/") + 1);
}

function target(destination: BackupDestinationView): string {
  const host = (() => {
    try {
      return new URL(destination.endpoint).host;
    } catch {
      return destination.endpoint;
    }
  })();
  return `${host} · ${destination.bucket}${destination.prefix ? `/${destination.prefix}` : ""}`;
}

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function LastRun({ destination }: { destination: BackupDestinationView }) {
  const fmt = useFormat();
  if (destination.running) return <StatusDot tone="info" pulse label="Running" />;
  if (!destination.lastRunAt) return <span className="text-soft">Never</span>;
  if (destination.lastStatus === "failed") {
    return (
      <div className="flex flex-col gap-1">
        <StatusDot
          tone="bad"
          label={
            <span>
              Failed{destination.consecutiveFailures > 1 ? <> ×<span className="num">{destination.consecutiveFailures}</span></> : ""}{" "}
              <span className="num font-normal">{fmt.dateTime(destination.lastRunAt)}</span>
            </span>
          }
        />
        {destination.lastError && <p className="m-0 max-w-xs break-words text-xs text-bad">{destination.lastError}</p>}
      </div>
    );
  }
  return <StatusDot tone="ok" label={<span className="num">{fmt.dateTime(destination.lastRunAt)}</span>} />;
}

function RunStatus({ run }: { run: BackupRunView }) {
  if (run.status === "running") return <StatusDot tone="info" pulse label="Running" />;
  if (run.status === "failed") return <StatusDot tone="bad" label="Failed" />;
  return <StatusDot tone={run.warning ? "warn" : "ok"} label="Uploaded" />;
}

export default function BackupsTab({ destinations, runs, configurable, isSlave, editionLabel, minPassphraseLength }: Props) {
  const router = useRouter();
  const fmt = useFormat();
  const { productName } = useBranding();
  const [pending, startTransition] = useTransition();

  const [editing, setEditing] = useState<BackupDestinationView | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<BackupDestinationView | null>(null);

  const [restoreTarget, setRestoreTarget] = useState<BackupDestinationView | null>(null);
  const [listing, setListing] = useState<BackupObjectsListing | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const canChange = configurable && !isSlave;
  const timeZones = useMemo(() => {
    try {
      const zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
      return zones.includes("UTC") ? zones : ["UTC", ...zones];
    } catch {
      return ["UTC"];
    }
  }, []);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((previous) => ({ ...previous, [key]: value }));

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(destination: BackupDestinationView) {
    setEditing(destination);
    setForm(formFromDestination(destination));
    setFormError(null);
    setFormOpen(true);
  }

  function applyPreset(id: string) {
    const preset = STORAGE_PRESETS.find((candidate) => candidate.id === id);
    if (!preset) return;
    setForm((previous) => ({
      ...previous,
      endpoint: preset.endpoint.replace("<region>", preset.region).replace("<location>", preset.region),
      region: preset.region,
      pathStyle: preset.pathStyle,
    }));
  }

  function save() {
    setFormError(null);
    if (form.passphrase !== form.passphraseConfirm) {
      setFormError("The passphrases do not match.");
      return;
    }
    if (form.passphrase && [...form.passphrase].length < minPassphraseLength) {
      setFormError(`Use a passphrase of at least ${minPassphraseLength} characters.`);
      return;
    }
    const schedule =
      form.kind === "hourly"
        ? { kind: "hourly", minute: Number(form.minute) }
        : form.kind === "daily"
          ? { kind: "daily", time: form.time }
          : { kind: "weekly", day: form.day, time: form.time };
    const body: Record<string, unknown> = {
      name: form.name,
      enabled: form.enabled,
      endpoint: form.endpoint,
      region: form.region,
      bucket: form.bucket,
      prefix: form.prefix,
      pathStyle: form.pathStyle,
      accessKeyId: form.accessKeyId,
      schedule,
      timeZone: form.timeZone,
      retention: Number(form.retention),
    };
    if (form.secretAccessKey) body.secretAccessKey = form.secretAccessKey;
    if (form.passphrase) body.passphrase = form.passphrase;
    startTransition(async () => {
      try {
        await requestJson(
          editing ? `/api/v1/backup-destinations/${editing.id}` : "/api/v1/backup-destinations",
          jsonInit(editing ? "PUT" : "POST", body)
        );
        toast.success(editing ? "Destination updated" : "Destination created");
        setFormOpen(false);
        router.refresh();
      } catch (error) {
        setFormError((error as Error).message);
      }
    });
  }

  function setEnabled(destination: BackupDestinationView, enabled: boolean) {
    startTransition(async () => {
      try {
        await requestJson(`/api/v1/backup-destinations/${destination.id}`, jsonInit("PUT", { enabled }));
      } catch (error) {
        toast.error((error as Error).message);
      }
      router.refresh();
    });
  }

  function runNow(destination: BackupDestinationView) {
    startTransition(async () => {
      try {
        const run = await requestJson<BackupRunView>(`/api/v1/backup-destinations/${destination.id}/run`, jsonInit("POST"));
        if (run.status === "success") {
          toast.success(`Uploaded ${fileName(run.objectKey)}${run.sizeBytes === null ? "" : ` (${formatBytes(run.sizeBytes)})`}`);
          if (run.warning) toast.warning(run.warning);
        } else {
          toast.error(run.error ?? "The backup failed");
        }
      } catch (error) {
        toast.error((error as Error).message);
      }
      router.refresh();
    });
  }

  function testConnection(destination: BackupDestinationView) {
    startTransition(async () => {
      try {
        const result = await requestJson<BackupTestResult>(`/api/v1/backup-destinations/${destination.id}/test`, jsonInit("POST"));
        if (result.ok) toast.success(`"${destination.name}": write, read and delete worked (${result.durationMs} ms)`);
        else toast.error(`"${destination.name}": ${result.failedStep} failed: ${result.error}`);
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  }

  function remove() {
    if (!deleteTarget) return;
    const destination = deleteTarget;
    startTransition(async () => {
      try {
        const response = await fetch(`/api/v1/backup-destinations/${destination.id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(await readError(response));
        toast.success("Destination deleted");
      } catch (error) {
        toast.error((error as Error).message);
      }
      setDeleteTarget(null);
      router.refresh();
    });
  }

  function openRestore(destination: BackupDestinationView) {
    setRestoreTarget(destination);
    setListing(null);
    setListingError(null);
    setSelectedKey(null);
    setRestorePassphrase("");
    setRestoreError(null);
    requestJson<BackupObjectsListing>(`/api/v1/backup-destinations/${destination.id}/objects`)
      .then((result) => {
        setListing(result);
        setSelectedKey(result.objects[0]?.key ?? null);
      })
      .catch((error: Error) => setListingError(error.message));
  }

  function restore() {
    if (!restoreTarget || !selectedKey) return;
    const destination = restoreTarget;
    const key = selectedKey;
    setRestoreError(null);
    startTransition(async () => {
      try {
        const result = await requestJson<BackupRestoreResult>(
          `/api/v1/backup-destinations/${destination.id}/restore`,
          jsonInit("POST", restorePassphrase ? { key, passphrase: restorePassphrase } : { key })
        );
        setRestoreTarget(null);
        setRestoreMessage({
          ok: true,
          text:
            `Restored ${fileName(key)} from "${destination.name}".` +
            (result.beforeSnapshotId ? ` The configuration it replaced is version #${result.beforeSnapshotId}.` : "") +
            (result.warning ? ` ${result.warning}.` : ""),
        });
        router.refresh();
      } catch (error) {
        setRestoreError((error as Error).message);
      }
    });
  }

  const passphraseStored = Boolean(editing?.hasPassphrase);

  return (
    <div className="flex flex-col gap-5">
      {!configurable && (
        <Banner tone="info">
          Scheduled backups need an active {productName} {editionLabel} license or higher.{" "}
          {destinations.length > 0 ? "Enabled destinations keep backing up on schedule; you can still disable and delete them. " : ""}
          Restoring from the dashboard needs the license too: without it, download a backup file from your bucket and load it with the
          free import (Export or import, above).{" "}
          <Link href="/license" className="text-brand underline underline-offset-4">
            Manage the license
          </Link>
          .
        </Banner>
      )}
      {restoreMessage && (
        <Banner tone={restoreMessage.ok ? "ok" : "bad"} live onDismiss={() => setRestoreMessage(null)} dismissLabel="Dismiss message">
          {restoreMessage.text}
        </Banner>
      )}

      <SectionCard
        title="Backup destinations"
        count={destinations.length}
        description="Scheduled exports of the configuration to your own S3-compatible storage"
        actions={
          <Button size="sm" onClick={openCreate} disabled={!canChange || pending} title={configurable ? undefined : LOCKED_HINT}>
            <Plus /> Add destination
          </Button>
        }
        footer={
          <p className="m-0 text-xs text-soft">
            On schedule, the configuration is exported like the free export (secrets encrypted with the destination&apos;s passphrase) and
            uploaded to your bucket: AWS S3, Cloudflare R2, Backblaze B2, Hetzner, Wasabi, MinIO and others. Older backups beyond the
            retention are deleted.
          </p>
        }
      >
        {destinations.length === 0 ? (
          <EmptyState
            compact
            icon={CloudUpload}
            title="No destinations yet"
            description="Add an S3-compatible bucket to back up the configuration on a schedule."
          />
        ) : (
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Destination</TableHead>
                <TableHead scope="col">Schedule</TableHead>
                <TableHead scope="col">Last backup</TableHead>
                <TableHead scope="col">Next</TableHead>
                <TableHead scope="col">Enabled</TableHead>
                <TableHead scope="col" className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {destinations.map((destination) => (
                <TableRow key={destination.id} className={destination.enabled ? undefined : "text-muted-foreground"}>
                  <TableCell className="align-top">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-semibold text-foreground">{destination.name}</span>
                      <span className="num max-w-[280px] truncate text-xs text-soft" title={target(destination)}>
                        {target(destination)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-col gap-0.5">
                      <span>{describeSchedule(destination.schedule, destination.timeZone)}</span>
                      <span className="text-xs text-soft">
                        Keeps <span className="num">{destination.retention}</span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <LastRun destination={destination} />
                  </TableCell>
                  <TableCell className="num whitespace-nowrap align-top text-muted-foreground">
                    {destination.enabled && destination.nextRunAt ? fmt.dateTime(destination.nextRunAt) : "Not scheduled"}
                  </TableCell>
                  <TableCell className="align-top">
                    <Switch
                      checked={destination.enabled}
                      // Turning off always works; turning on needs the license.
                      disabled={pending || (!canChange && !destination.enabled)}
                      onCheckedChange={(checked) => setEnabled(destination, checked)}
                      aria-label={destination.enabled ? `Disable destination "${destination.name}"` : `Enable destination "${destination.name}"`}
                      title={!configurable && !destination.enabled ? LOCKED_HINT : undefined}
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right align-top">
                    <div className="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={canChange ? "Back up now" : LOCKED_HINT}
                        aria-label={`Back up to "${destination.name}" now`}
                        disabled={!canChange || pending || destination.running}
                        onClick={() => runNow(destination)}
                      >
                        <CloudUpload />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={configurable ? "Test the connection" : LOCKED_HINT}
                        aria-label={`Test "${destination.name}"`}
                        disabled={!configurable || pending}
                        onClick={() => testConnection(destination)}
                      >
                        <Plug />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Restore a backup"
                        aria-label={`Restore from "${destination.name}"`}
                        disabled={pending}
                        onClick={() => openRestore(destination)}
                      >
                        <RotateCcw />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={configurable ? "Edit" : LOCKED_HINT}
                        aria-label={`Edit "${destination.name}"`}
                        disabled={!configurable || pending}
                        onClick={() => openEdit(destination)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-bad hover:text-bad"
                        title="Delete"
                        aria-label={`Delete "${destination.name}"`}
                        disabled={pending}
                        onClick={() => setDeleteTarget(destination)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard
        title="Recent backups"
        description={
          runs.total === 0
            ? "No backups yet"
            : `The latest ${Math.min(runs.runs.length, runs.total)} of ${runs.total} runs. Failed backups are retried after 5 minutes, then with growing delays.`
        }
        divided={runs.runs.length > 0}
      >
        {runs.runs.length > 0 && (
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Started</TableHead>
                <TableHead scope="col">Destination</TableHead>
                <TableHead scope="col">Trigger</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">File</TableHead>
                <TableHead scope="col" className="text-right">
                  Size
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="num whitespace-nowrap align-top text-muted-foreground">{fmt.dateTime(run.startedAt)}</TableCell>
                  <TableCell className="align-top">{run.destinationName ?? `#${run.destinationId}`}</TableCell>
                  <TableCell className="align-top">
                    <Badge variant="muted">{run.trigger === "manual" ? "Manual" : "Scheduled"}</Badge>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-col gap-1">
                      <RunStatus run={run} />
                      {(run.error || run.warning) && (
                        <p className={cn("m-0 max-w-sm break-words text-xs", run.error ? "text-bad" : "text-muted-foreground")}>{run.error ?? run.warning}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="num break-all align-top text-xs" title={run.sha256 ? `SHA-256 ${run.sha256}` : undefined}>
                    {fileName(run.objectKey)}
                    {run.prunedCount ? <span className="font-sans text-soft"> (deleted {run.prunedCount} older)</span> : null}
                  </TableCell>
                  <TableCell className="num text-right align-top text-xs text-muted-foreground">
                    {run.sizeBytes === null ? "" : formatBytes(run.sizeBytes)}
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
        title={editing ? `Edit destination "${editing.name}"` : "Add backup destination"}
        submitLabel={editing ? "Save" : "Create"}
        onSubmit={save}
        isSubmitting={pending}
        maxWidth="lg"
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="backup-name">
              <Input id="backup-name" value={form.name} maxLength={100} onChange={(event) => set("name", event.target.value)} />
            </Field>
            <Field label="Provider" hint="Fills in the endpoint, region and addressing; adjust the placeholders.">
              <Select onValueChange={applyPreset}>
                <SelectTrigger aria-label="Storage provider">
                  <SelectValue placeholder="Choose a provider (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {STORAGE_PRESETS.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field label="Endpoint" htmlFor="backup-endpoint" hint="The S3 API URL, without the bucket.">
                <Input
                  id="backup-endpoint"
                  value={form.endpoint}
                  placeholder="https://s3.eu-central-1.amazonaws.com"
                  onChange={(event) => set("endpoint", event.target.value)}
                />
              </Field>
            </div>
            <Field label="Region" htmlFor="backup-region">
              <Input id="backup-region" value={form.region} onChange={(event) => set("region", event.target.value)} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Bucket" htmlFor="backup-bucket">
              <Input id="backup-bucket" value={form.bucket} onChange={(event) => set("bucket", event.target.value)} />
            </Field>
            <Field label="Folder (key prefix)" htmlFor="backup-prefix" hint="Files are stored as <folder>/ingressi-config-<time>.json.">
              <Input id="backup-prefix" value={form.prefix} onChange={(event) => set("prefix", event.target.value)} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.pathStyle} onCheckedChange={(checked) => set("pathStyle", checked)} />
            Path-style addressing (endpoint/bucket/key; needed for MinIO and IP addresses)
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Access key ID" htmlFor="backup-access-key">
              <Input id="backup-access-key" autoComplete="off" value={form.accessKeyId} onChange={(event) => set("accessKeyId", event.target.value)} />
            </Field>
            <Field
              label="Secret access key"
              htmlFor="backup-secret-key"
              hint={editing ? "Enter it again when you change the endpoint." : "Stored encrypted; never shown again."}
            >
              <Input
                id="backup-secret-key"
                type="password"
                autoComplete="new-password"
                value={form.secretAccessKey}
                placeholder={editing?.hasSecretAccessKey ? "Stored; leave empty to keep" : ""}
                onChange={(event) => set("secretAccessKey", event.target.value)}
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Backup passphrase" htmlFor="backup-passphrase">
              <Input
                id="backup-passphrase"
                type="password"
                autoComplete="new-password"
                value={form.passphrase}
                placeholder={passphraseStored ? "Stored; leave empty to keep" : `At least ${minPassphraseLength} characters`}
                onChange={(event) => set("passphrase", event.target.value)}
              />
            </Field>
            <Field label="Repeat passphrase" htmlFor="backup-passphrase-confirm">
              <Input
                id="backup-passphrase-confirm"
                type="password"
                autoComplete="new-password"
                value={form.passphraseConfirm}
                onChange={(event) => set("passphraseConfirm", event.target.value)}
              />
            </Field>
          </div>
          <Banner tone="warn">
            Save the passphrase in your password manager now. It encrypts the private keys and credentials inside every
              backup, and restoring a backup on a new machine is impossible without it.
            {passphraseStored ? " A new passphrase applies to new backups only; older ones still need the old one." : ""}
          </Banner>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Schedule">
              <Select value={form.kind} onValueChange={(value) => set("kind", value as ScheduleKind)}>
                <SelectTrigger aria-label="Schedule">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">Every hour</SelectItem>
                  <SelectItem value="daily">Every day</SelectItem>
                  <SelectItem value="weekly">Every week</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {form.kind === "hourly" ? (
              <Field label="At minute" htmlFor="backup-minute">
                <Input id="backup-minute" type="number" min={0} max={59} value={form.minute} onChange={(event) => set("minute", event.target.value)} />
              </Field>
            ) : (
              <Field label="At" htmlFor="backup-time">
                <Input id="backup-time" type="time" value={form.time} onChange={(event) => set("time", event.target.value)} />
              </Field>
            )}
            {form.kind === "weekly" && (
              <Field label="On">
                <Select value={form.day} onValueChange={(value) => set("day", value as Weekday)}>
                  <SelectTrigger aria-label="Day of the week">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((day) => (
                      <SelectItem key={day} value={day}>
                        {WEEKDAY_LABELS[day]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Time zone" htmlFor="backup-time-zone">
              <Input id="backup-time-zone" list="backup-time-zones" value={form.timeZone} onChange={(event) => set("timeZone", event.target.value)} />
              <datalist id="backup-time-zones">
                {timeZones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </Field>
            <Field label="Backups to keep" htmlFor="backup-retention" hint="Older backup files in the folder are deleted.">
              <Input
                id="backup-retention"
                type="number"
                min={MIN_RETENTION}
                max={MAX_RETENTION}
                value={form.retention}
                onChange={(event) => set("retention", event.target.value)}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.enabled} onCheckedChange={(checked) => set("enabled", checked)} />
            Enabled
          </label>
          {formError && (
            <Banner tone="bad" live>
              {formError}
            </Banner>
          )}
        </div>
      </AppDialog>

      <AppDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete destination "${deleteTarget?.name ?? ""}"?`}
        submitLabel="Delete"
        onSubmit={remove}
        isSubmitting={pending}
      >
        <p className="text-sm">
          No more backups are made to it and its run history is deleted. The backup files already in the bucket are kept.
        </p>
      </AppDialog>

      <AppDialog
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        title={`Restore from "${restoreTarget?.name ?? ""}"`}
        submitLabel="Restore"
        onSubmit={canChange && selectedKey ? restore : undefined}
        isSubmitting={pending}
        maxWidth="lg"
      >
        <div className="space-y-3 text-sm">
          <p>
            The configuration is replaced with the selected backup and applied to Caddy, like an import. Users, group members,
            sign-in settings and API tokens are not changed.
          </p>
          {!canChange && (
            <Banner tone="info">
              {isSlave
                  ? "This instance is a sync slave: restore on the master."
                : "Restoring needs the license. Download the file from your bucket and use the free import instead."}
            </Banner>
          )}
          {listingError && (
            <Banner tone="bad" live>
              {listingError}
            </Banner>
          )}
          {!listing && !listingError && <p className="text-muted-foreground">Listing backups…</p>}
          {listing && listing.objects.length === 0 && <p className="text-muted-foreground">No backups in this folder.</p>}
          {listing && listing.objects.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>File</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listing.objects.map((object: BackupObjectView) => (
                    <TableRow key={object.key} className="cursor-pointer" onClick={() => setSelectedKey(object.key)}>
                      <TableCell>
                        <input
                          type="radio"
                          name="backup-object"
                          aria-label={fileName(object.key)}
                          checked={selectedKey === object.key}
                          onChange={() => setSelectedKey(object.key)}
                        />
                      </TableCell>
                      <TableCell className="num break-all text-xs">{fileName(object.key)}</TableCell>
                      <TableCell className="num text-right text-xs text-muted-foreground">{formatBytes(object.sizeBytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {listing && !listing.complete && (
            <p className="text-xs text-muted-foreground">The folder holds more files than could be listed.</p>
          )}
          <Field
            label="Passphrase (optional)"
            htmlFor="restore-passphrase"
            hint="Leave empty to use the destination's passphrase; enter the old one for backups made before it changed."
          >
            <Input
              id="restore-passphrase"
              type="password"
              autoComplete="off"
              value={restorePassphrase}
              disabled={!canChange}
              onChange={(event) => setRestorePassphrase(event.target.value)}
            />
          </Field>
          {restoreError && (
            <Banner tone="bad" live>
              {restoreError}
            </Banner>
          )}
        </div>
      </AppDialog>
    </div>
  );
}

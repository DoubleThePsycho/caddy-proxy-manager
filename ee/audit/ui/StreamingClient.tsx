// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, RadioTower, Send, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui/SectionCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/ui/StatusDot";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import {
  AUDIT_SINK_TYPE_LABELS,
  SYSLOG_DEFAULT_FACILITY,
  SYSLOG_DEFAULT_PORTS,
  type AuditRetentionView,
  type AuditSinkType,
  type AuditSinkView,
  type SplunkHecSinkConfig,
  type SyslogProtocol,
  type SyslogSinkConfig,
  type WebhookSinkConfig,
} from "@/ee/audit/types";
import { LAG_WARNING_MS, formatLag } from "./sink-view";
import {
  createAuditSinkAction,
  deleteAuditSinkAction,
  saveAuditRetentionAction,
  testAuditSinkAction,
  updateAuditSinkAction,
} from "./streaming-actions";

type Props = {
  sinks: AuditSinkView[];
  retention: AuditRetentionView;
  /** Whether the license allows changing sinks and retention. */
  licensed: boolean;
  /** When the page was built; lags are measured against it. */
  generatedAt: string;
};

type FormState = {
  name: string;
  type: AuditSinkType;
  enabled: boolean;
  url: string;
  index: string;
  host: string;
  port: string;
  protocol: SyslogProtocol;
  facility: string;
  caPem: string;
  secret: string;
  backfill: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  type: "webhook",
  enabled: true,
  url: "",
  index: "",
  host: "",
  port: "",
  protocol: "udp",
  facility: String(SYSLOG_DEFAULT_FACILITY),
  caPem: "",
  secret: "",
  backfill: false,
};

function formFromSink(sink: AuditSinkView): FormState {
  const form: FormState = { ...EMPTY_FORM, name: sink.name, type: sink.type, enabled: sink.enabled };
  if (sink.type === "syslog") {
    const config = sink.config as SyslogSinkConfig;
    return {
      ...form,
      host: config.host,
      port: String(config.port),
      protocol: config.protocol,
      facility: String(config.facility),
      caPem: config.caPem ?? "",
    };
  }
  if (sink.type === "splunk_hec") {
    const config = sink.config as SplunkHecSinkConfig;
    return { ...form, url: config.url, index: config.index ?? "" };
  }
  return { ...form, url: (sink.config as WebhookSinkConfig).url };
}

/** The API body for the form; an empty secret on edit keeps the stored one. */
function bodyFromForm(form: FormState, editing: boolean): Record<string, unknown> {
  const config =
    form.type === "syslog"
      ? {
          host: form.host,
          port: form.port.trim() === "" ? null : Number(form.port),
          protocol: form.protocol,
          facility: form.facility.trim() === "" ? undefined : Number(form.facility),
          caPem: form.protocol === "tls" && form.caPem.trim() ? form.caPem : null,
        }
      : form.type === "splunk_hec"
        ? { url: form.url, index: form.index.trim() || null }
        : { url: form.url };
  const body: Record<string, unknown> = { name: form.name, enabled: form.enabled, config };
  if (!editing) {
    body.type = form.type;
    body.backfill = form.backfill;
  }
  if (form.type !== "syslog" && (form.secret !== "" || !editing)) body.secret = form.secret;
  return body;
}

function describeTarget(sink: AuditSinkView): string {
  if (sink.type === "syslog") {
    const config = sink.config as SyslogSinkConfig;
    return `${config.protocol.toUpperCase()} ${config.host}:${config.port}`;
  }
  return (sink.config as WebhookSinkConfig).url;
}

function SinkStatus({ sink }: { sink: AuditSinkView }) {
  if (!sink.enabled) return <StatusDot tone="off" label="Disabled" />;
  if (sink.consecutiveFailures > 0) return <StatusDot tone="bad" label="Failing" />;
  if (!sink.lastDeliveryAt) return <StatusDot tone="info" label="Waiting for events" />;
  return <StatusDot tone="ok" label="Delivering" />;
}

export default function StreamingClient({ sinks, retention, licensed, generatedAt }: Props) {
  const router = useRouter();
  const { productName } = useBranding();
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; sink: AuditSinkView } | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AuditSinkView | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [days, setDays] = useState(String(retention.days));

  const editing = dialog?.mode === "edit";
  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialog({ mode: "create" });
  }

  function openEdit(sink: AuditSinkView) {
    setForm(formFromSink(sink));
    setFormError(null);
    setDialog({ mode: "edit", sink });
  }

  function submit() {
    if (!dialog) return;
    setFormError(null);
    startTransition(async () => {
      const body = bodyFromForm(form, dialog.mode === "edit");
      const result =
        dialog.mode === "edit" ? await updateAuditSinkAction(dialog.sink.id, body) : await createAuditSinkAction(body);
      if ("error" in result) {
        setFormError(result.error);
        return;
      }
      toast.success(dialog.mode === "edit" ? "Sink updated" : "Sink created");
      setDialog(null);
      router.refresh();
    });
  }

  function remove() {
    if (!deleting) return;
    startTransition(async () => {
      const result = await deleteAuditSinkAction(deleting.id);
      if ("error" in result) toast.error(result.error);
      else toast.success(`Deleted ${deleting.name}`);
      setDeleting(null);
      router.refresh();
    });
  }

  function test(sink: AuditSinkView) {
    setTestingId(sink.id);
    startTransition(async () => {
      const outcome = await testAuditSinkAction(sink.id);
      setTestingId(null);
      if ("error" in outcome) toast.error(outcome.error);
      else if (outcome.result.ok) toast.success(`${sink.name} accepted the test event (${outcome.result.durationMs} ms)`);
      else toast.error(`${sink.name}: ${outcome.result.error}`);
    });
  }

  function setEnabled(sink: AuditSinkView, enabled: boolean) {
    startTransition(async () => {
      const result = await updateAuditSinkAction(sink.id, { enabled });
      if ("error" in result) toast.error(result.error);
      else toast.success(`${sink.name} ${enabled ? "enabled" : "disabled"}`);
      router.refresh();
    });
  }

  function saveRetention(value: number = Number(days)) {
    startTransition(async () => {
      const result = await saveAuditRetentionAction(value);
      if ("error" in result) {
        toast.error(result.error);
      } else {
        setDays(String(value));
        toast.success(value === 0 ? "Audit events are kept forever" : `Audit events are kept for ${value} days`);
      }
      router.refresh();
    });
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Observe", { label: "Audit log", href: "/audit-log" }, "Streaming"]}
        title="Audit streaming"
        description={`Send ${productName}'s audit log to a SIEM as it is written, and choose how long it is kept.`}
        actions={
          licensed ? (
            <Button onClick={openCreate}>
              <Plus />
              Add sink
            </Button>
          ) : undefined
        }
      />

      {!licensed && (
        <Banner tone="info">
          Setting up, changing or enabling sinks and retention needs a Business license. You can still disable or delete sinks and
          turn retention off.{" "}
          <Link href="/license" className="text-brand underline underline-offset-4">
            Manage the license
          </Link>
        </Banner>
      )}

      <SectionCard title="Destinations" count={sinks.length}>
        {sinks.length === 0 ? (
          <EmptyState
            icon={RadioTower}
            title="No sinks yet"
            description="Add a webhook, syslog or Splunk HEC sink."
            action={
              licensed ? (
                <Button onClick={openCreate}>
                  <Plus />
                  Add sink
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {sinks.map((sink) => (
              <li key={sink.id} className="flex flex-col gap-3 border-b border-line px-[18px] py-4 last:border-b-0">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="m-0 text-[15px] leading-[22px] font-semibold">{sink.name}</h3>
                      <span className="whitespace-nowrap rounded-full border border-line2 px-2 text-xs leading-5 text-muted-foreground">
                        {AUDIT_SINK_TYPE_LABELS[sink.type]}
                      </span>
                      <SinkStatus sink={sink} />
                    </div>
                    <p className="num m-0 text-xs text-soft [overflow-wrap:anywhere]">{describeTarget(sink)}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Switch
                      checked={sink.enabled}
                      onCheckedChange={(checked) => setEnabled(sink, checked)}
                      disabled={pending || (!licensed && !sink.enabled)}
                      aria-label={sink.enabled ? `Disable ${sink.name}` : `Enable ${sink.name}`}
                      title={sink.enabled ? "Disable" : "Enable"}
                      className="mr-1.5"
                    />
                    <Button variant="outline" size="sm" onClick={() => test(sink)} disabled={!licensed || pending}>
                      <Send /> {testingId === sink.id ? "Sending…" : "Send test event"}
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(sink)} disabled={!licensed} title="Edit sink" aria-label={`Edit ${sink.name}`}>
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-bad hover:text-bad"
                      onClick={() => setDeleting(sink)}
                      title="Delete sink"
                      aria-label={`Delete ${sink.name}`}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
                  <div className="flex min-w-0 flex-col">
                    <dt className="text-xs text-soft">Last delivery</dt>
                    <dd className="num m-0">{sink.lastDeliveryAt ? format.dateTime(sink.lastDeliveryAt) : "Never"}</dd>
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <dt className="text-xs text-soft">Delivered up to</dt>
                    <dd className="num m-0">{sink.lastDeliveredId > 0 ? `event #${sink.lastDeliveredId}` : "None yet"}</dd>
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <dt className="text-xs text-soft">Waiting</dt>
                    <dd className="num m-0">{format.number(sink.pendingEvents)}</dd>
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <dt className="text-xs text-soft">Lag</dt>
                    <dd
                      className={cn(
                        "num m-0",
                        sink.oldestPendingAt && Date.parse(generatedAt) - Date.parse(sink.oldestPendingAt) > LAG_WARNING_MS && "text-bad"
                      )}
                    >
                      {sink.oldestPendingAt ? formatLag(sink.oldestPendingAt, generatedAt) : "None"}
                    </dd>
                  </div>
                </dl>
                {sink.lastError && (
                  <p className={cn("m-0 text-[13px]", sink.consecutiveFailures > 0 ? "text-bad" : "text-muted-foreground")}>
                    {sink.consecutiveFailures > 0 ? "Last attempt failed" : "Last error"} at{" "}
                    <span className="num">{sink.lastErrorAt ? format.dateTime(sink.lastErrorAt) : "an unknown time"}</span>: {sink.lastError}
                    {sink.consecutiveFailures > 0 && sink.nextAttemptAt && (
                      <>
                        {" "}
                        ({sink.consecutiveFailures} failed attempt{sink.consecutiveFailures === 1 ? "" : "s"} in a row, next at{" "}
                        <span className="num">{format.dateTime(sink.nextAttemptAt)}</span>)
                      </>
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Retention" padded>
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[13px] text-muted-foreground">
            Older events are deleted, including events not yet delivered to a failing sink.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="retention-days">Keep events for (days, 0 = forever)</Label>
              <Input
                id="retention-days"
                type="number"
                min={0}
                max={36500}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                disabled={!licensed}
                className="num w-40"
              />
            </div>
            <Button onClick={() => saveRetention()} disabled={!licensed || pending || days.trim() === ""}>
              Save
            </Button>
            {!licensed && retention.days > 0 && (
              <Button variant="outline" onClick={() => saveRetention(0)} disabled={pending}>
                Keep events forever
              </Button>
            )}
          </div>
          <p className="m-0 text-[13px] text-muted-foreground">
            {retention.lastRunAt ? (
              <>
                Last run <span className="num">{format.dateTime(retention.lastRunAt)}</span>: deleted{" "}
                <span className="num">{format.number(retention.lastDeleted ?? 0)}</span> events.
              </>
            ) : (
              "Not run yet."
            )}
          </p>
        </div>
      </SectionCard>

      <AppDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={editing ? "Edit sink" : "Add sink"}
        submitLabel={editing ? "Save" : "Create"}
        onSubmit={submit}
        isSubmitting={pending}
        maxWidth="md"
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="sink-name">Name</Label>
            <Input id="sink-name" value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. SIEM" />
          </div>
          <div className="space-y-1">
            <Label>Type</Label>
            <Select value={form.type} onValueChange={(value) => update({ type: value as AuditSinkType })} disabled={editing}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="webhook">Webhook</SelectItem>
                <SelectItem value="syslog">Syslog (RFC 5424)</SelectItem>
                <SelectItem value="splunk_hec">Splunk HTTP Event Collector</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.type !== "syslog" && (
            <>
              <div className="space-y-1">
                <Label htmlFor="sink-url">{form.type === "splunk_hec" ? "HEC URL" : "URL"}</Label>
                <Input
                  id="sink-url"
                  value={form.url}
                  onChange={(e) => update({ url: e.target.value })}
                  placeholder={form.type === "splunk_hec" ? "https://splunk.example.com:8088" : "https://siem.example.com/ingest"}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sink-secret">{form.type === "splunk_hec" ? "HEC token" : "Signing secret"}</Label>
                <Input
                  id="sink-secret"
                  type="password"
                  autoComplete="new-password"
                  value={form.secret}
                  onChange={(e) => update({ secret: e.target.value })}
                  placeholder={editing ? "Leave empty to keep the stored value" : undefined}
                />
                {form.type === "webhook" && (
                  <p className="text-xs text-muted-foreground">At least 16 characters. Requests are signed with it.</p>
                )}
              </div>
              {form.type === "splunk_hec" && (
                <div className="space-y-1">
                  <Label htmlFor="sink-index">Index (optional)</Label>
                  <Input id="sink-index" value={form.index} onChange={(e) => update({ index: e.target.value })} />
                </div>
              )}
            </>
          )}

          {form.type === "syslog" && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1 col-span-2">
                  <Label htmlFor="sink-host">Host</Label>
                  <Input id="sink-host" value={form.host} onChange={(e) => update({ host: e.target.value })} placeholder="syslog.example.com" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sink-port">Port</Label>
                  <Input
                    id="sink-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.port}
                    onChange={(e) => update({ port: e.target.value })}
                    placeholder={String(SYSLOG_DEFAULT_PORTS[form.protocol])}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Protocol</Label>
                  <Select value={form.protocol} onValueChange={(value) => update({ protocol: value as SyslogProtocol })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="udp">UDP</SelectItem>
                      <SelectItem value="tcp">TCP</SelectItem>
                      <SelectItem value="tls">TLS</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sink-facility">Facility (0–23)</Label>
                  <Input
                    id="sink-facility"
                    type="number"
                    min={0}
                    max={23}
                    value={form.facility}
                    onChange={(e) => update({ facility: e.target.value })}
                  />
                </div>
              </div>
              {form.protocol === "tls" && (
                <div className="space-y-1">
                  <Label htmlFor="sink-ca">CA certificate (optional)</Label>
                  <Textarea
                    id="sink-ca"
                    rows={4}
                    className="font-mono text-xs"
                    value={form.caPem}
                    onChange={(e) => update({ caPem: e.target.value })}
                    placeholder="-----BEGIN CERTIFICATE-----"
                  />
                  <p className="text-xs text-muted-foreground">PEM of the CA that signs the receiver&apos;s certificate, if not a public one.</p>
                </div>
              )}
            </>
          )}

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="sink-enabled">Enabled</Label>
            <Switch id="sink-enabled" checked={form.enabled} onCheckedChange={(checked) => update({ enabled: checked })} />
          </div>
          {!editing && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="sink-backfill">Send events already in the log</Label>
                <p className="text-xs text-muted-foreground">Otherwise the sink receives events recorded from now on.</p>
              </div>
              <Switch id="sink-backfill" checked={form.backfill} onCheckedChange={(checked) => update({ backfill: checked })} />
            </div>
          )}
          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
        </div>
      </AppDialog>

      <AppDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? "sink"}?`}
        submitLabel="Delete"
        onSubmit={remove}
        isSubmitting={pending}
      >
        <p className="text-sm text-muted-foreground">
          Events stop being sent to this destination. Events not yet delivered are not sent.
        </p>
      </AppDialog>
    </div>
  );
}

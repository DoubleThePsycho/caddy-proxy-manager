// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useEffect, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { DiffView as SharedDiffView } from "@/components/ui/DiffView";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ConfigDiff, EntityDiff } from "@/ee/config-history/diff";
import type { PromotionPreview } from "@/ee/fleet/rollouts";
import { MAX_CANARY_WAIT_SECONDS, type EnvironmentView } from "@/ee/fleet/types";

export async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (HTTP ${response.status})`;
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await readError(response));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** Long values cut to 240 characters; unset values stay unset (the diff shows them as "not set"). */
function shorten(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

/** One entity type of a configuration diff: items added and removed, then each changed item field by field. */
function EntityChanges({ entity }: { entity: EntityDiff }) {
  return (
    <section aria-label={entity.label} className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="m-0 text-sm font-semibold">{entity.label}</h4>
        {entity.added.length > 0 && <Badge variant="success">{entity.added.length} added</Badge>}
        {entity.removed.length > 0 && <Badge variant="destructive">{entity.removed.length} removed</Badge>}
        {entity.changed.length > 0 && <Badge variant="warning">{entity.changed.length} changed</Badge>}
      </div>
      {(entity.added.length > 0 || entity.removed.length > 0) && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
          {entity.added.map((item) => (
            <li key={`added-${item.id}`} className="flex gap-2">
              <span aria-hidden="true" className="num w-3 font-semibold text-ok">+</span>
              <span className="sr-only">Added: </span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{item.label}</span>
            </li>
          ))}
          {entity.removed.map((item) => (
            <li key={`removed-${item.id}`} className="flex gap-2">
              <span aria-hidden="true" className="num w-3 font-semibold text-bad">−</span>
              <span className="sr-only">Removed: </span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{item.label}</span>
            </li>
          ))}
        </ul>
      )}
      {entity.changed.map((item) => (
        <SharedDiffView
          key={`changed-${item.id}`}
          title={<span className="text-foreground">{item.label}</span>}
          label={`Changes to ${item.label}`}
          fields={item.changes.map((change) => ({
            path: change.path,
            before: change.secret ? undefined : shorten(change.before),
            after: change.secret ? undefined : shorten(change.after),
            secret: change.secret === true,
          }))}
        />
      ))}
    </section>
  );
}

/** What a revision changes, per entity type. Secrets only show that they changed. */
export function DiffView({ diff, empty = "No differences." }: { diff: ConfigDiff; empty?: string }) {
  if (diff.entities.length === 0) return <p className="text-[13px] text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-col gap-3">
      {diff.entities.map((entity) => (
        <EntityChanges key={entity.entity} entity={entity} />
      ))}
    </div>
  );
}

// ── Environment ─────────────────────────────────────────────────────────

type EnvironmentForm = {
  name: string;
  description: string;
  position: string;
  promotionOnly: boolean;
  canaryEnabled: boolean;
  canaryWaitSeconds: string;
  checkCaddyStatus: boolean;
};

function formFor(environment: EnvironmentView | null, nextPosition: number): EnvironmentForm {
  return {
    name: environment?.name ?? "",
    description: environment?.description ?? "",
    position: String(environment?.position ?? nextPosition),
    promotionOnly: environment?.promotionOnly ?? false,
    canaryEnabled: environment?.canary.enabled ?? true,
    canaryWaitSeconds: String(environment?.canary.waitSeconds ?? 300),
    checkCaddyStatus: environment?.canary.checkCaddyStatus ?? true,
  };
}

export function EnvironmentDialog({
  open,
  environment,
  nextPosition,
  canRelease,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null: create a new environment. */
  environment: EnvironmentView | null;
  nextPosition: number;
  canRelease: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState<EnvironmentForm>(() => formFor(environment, nextPosition));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(formFor(environment, nextPosition));
      setError(null);
    }
  }, [open, environment, nextPosition]);

  const releasing = environment?.promotionOnly === true && !form.promotionOnly;
  async function save() {
    setError(null);
    const position = Number(form.position);
    const wait = Number(form.canaryWaitSeconds);
    if (!form.name.trim()) return setError("Enter a name.");
    if (!Number.isInteger(position) || position < 0 || position > 10000) return setError("Position must be a whole number from 0 to 10000.");
    if (!Number.isInteger(wait) || wait < 0 || wait > MAX_CANARY_WAIT_SECONDS) {
      return setError(`The canary wait must be a whole number of seconds from 0 to ${MAX_CANARY_WAIT_SECONDS}.`);
    }
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      position,
      promotionOnly: form.promotionOnly,
      canary: { enabled: form.canaryEnabled, waitSeconds: wait, checkCaddyStatus: form.checkCaddyStatus },
    };
    setSaving(true);
    try {
      if (environment) {
        await requestJson(`/api/v1/fleet/environments/${environment.id}`, jsonInit("PATCH", body));
        onSaved(`Saved environment "${form.name.trim() || environment.name}".`);
      } else {
        await requestJson("/api/v1/fleet/environments", jsonInit("POST", body));
        onSaved(`Created environment "${form.name.trim()}".`);
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={environment ? `Edit environment "${environment.name}"` : "New environment"}
      maxWidth="md"
      submitLabel="Save"
      onSubmit={save}
      isSubmitting={saving}
    >
      <div className="space-y-4 text-sm">
        <div className="space-y-1">
          <Label htmlFor="fleet-env-name">Name</Label>
          <Input id="fleet-env-name" maxLength={100} value={form.name} disabled={saving} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="production" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="fleet-env-description">Description</Label>
          <Textarea id="fleet-env-description" maxLength={500} rows={2} value={form.description} disabled={saving} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="fleet-env-position">Position</Label>
          <Input id="fleet-env-position" inputMode="numeric" className="max-w-32" value={form.position} disabled={saving} onChange={(event) => setForm({ ...form, position: event.target.value })} />
          <p className="text-xs text-soft">Promotion order, lowest first: an environment promotes from the one before it.</p>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="fleet-env-promotion">Promotion only</Label>
            <p className="text-xs text-soft">
              Off: instances receive every change at once. On: they stay on a pinned revision until it is promoted.
            </p>
          </div>
          <Switch
            id="fleet-env-promotion"
            checked={form.promotionOnly}
            disabled={saving}
            onCheckedChange={(checked) => setForm({ ...form, promotionOnly: checked })}
          />
        </div>
        {releasing && (
          <Banner tone="warn">
            Its instances receive the master&apos;s configuration with the next change or sync, and the pinned revision is dropped.
            {!canRelease && " Releasing instances from promotion needs the fleet:promote permission."}
          </Banner>
        )}
        <div className="space-y-3 rounded-xl border border-line bg-panel2 p-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="fleet-env-canary">Canary first</Label>
              <p className="text-xs text-soft">Promotions go to one instance first and continue only if it stays healthy.</p>
            </div>
            <Switch id="fleet-env-canary" checked={form.canaryEnabled} disabled={saving} onCheckedChange={(checked) => setForm({ ...form, canaryEnabled: checked })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fleet-env-wait">Observe the canary for (seconds)</Label>
            <Input id="fleet-env-wait" inputMode="numeric" className="max-w-32" value={form.canaryWaitSeconds} disabled={saving || !form.canaryEnabled} onChange={(event) => setForm({ ...form, canaryWaitSeconds: event.target.value })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="fleet-env-caddy">Check Caddy status</Label>
              <p className="text-xs text-soft">Also fail when Caddy on the canary rejected the configuration or it changed there.</p>
            </div>
            <Switch id="fleet-env-caddy" checked={form.checkCaddyStatus} disabled={saving || !form.canaryEnabled} onCheckedChange={(checked) => setForm({ ...form, checkCaddyStatus: checked })} />
          </div>
        </div>
        {error && (
          <Banner tone="bad" live>
            {error}
          </Banner>
        )}
      </div>
    </AppDialog>
  );
}

// ── Promotion ───────────────────────────────────────────────────────────

export function PromoteDialog({
  environment,
  instanceNames,
  onClose,
  onStarted,
}: {
  environment: EnvironmentView | null;
  instanceNames: Map<number, string>;
  onClose: () => void;
  onStarted: (message: string) => void;
}) {
  const [preview, setPreview] = useState<PromotionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [canaryEnabled, setCanaryEnabled] = useState(true);
  const [canaryInstance, setCanaryInstance] = useState<string>("");
  const [waitSeconds, setWaitSeconds] = useState("300");
  const [checkCaddy, setCheckCaddy] = useState(true);

  useEffect(() => {
    if (!environment) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    requestJson<PromotionPreview>(`/api/v1/fleet/promotions/preview?environmentId=${environment.id}`)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setCanaryEnabled(result.canary.enabled && result.targets.length > 0);
        setCanaryInstance(result.targets[0] ? String(result.targets[0].instanceId) : "");
        setWaitSeconds(String(result.canary.waitSeconds));
        setCheckCaddy(result.canary.checkCaddyStatus);
      })
      .catch((caught: Error) => {
        if (!cancelled) setError(caught.message);
      });
    return () => {
      cancelled = true;
    };
  }, [environment]);

  async function start() {
    if (!environment || !preview) return;
    const wait = Number(waitSeconds);
    if (canaryEnabled && (!Number.isInteger(wait) || wait < 0 || wait > MAX_CANARY_WAIT_SECONDS)) {
      setError(`The canary wait must be a whole number of seconds from 0 to ${MAX_CANARY_WAIT_SECONDS}.`);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const rollout = await requestJson<{ id: number; revisionId: number }>(
        "/api/v1/fleet/rollouts",
        jsonInit("POST", {
          environmentId: environment.id,
          canary: canaryEnabled
            ? { enabled: true, instanceId: canaryInstance ? Number(canaryInstance) : null, waitSeconds: wait, checkCaddyStatus: checkCaddy }
            : false,
        })
      );
      onStarted(`Started rollout #${rollout.id} of revision #${rollout.revisionId} to "${environment.name}".`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const source = preview
    ? preview.source.environmentId === null
      ? "the master's current configuration"
      : preview.source.revisionId === null
        ? `what "${preview.source.environmentName}" runs (the master's current configuration)`
        : `revision #${preview.source.revisionId}, which "${preview.source.environmentName}" runs`
    : "";

  return (
    <AppDialog
      open={environment !== null}
      onClose={onClose}
      title={environment ? `Promote to "${environment.name}"` : "Promote"}
      maxWidth="xl"
      submitLabel="Start rollout"
      onSubmit={preview && !preview.upToDate ? start : undefined}
      isSubmitting={starting}
    >
      <div className="space-y-4 text-sm">
        {!preview && !error && <p className="text-muted-foreground">Comparing…</p>}
        {preview && (
          <>
            <p>
              Rolls out {source} to {preview.targets.length} instance{preview.targets.length === 1 ? "" : "s"}
              {preview.currentRevisionId !== null ? `, replacing revision #${preview.currentRevisionId}` : ""}.
            </p>
            {preview.upToDate && (
              <Banner tone="info">The environment and all its instances already run this configuration.</Banner>
            )}
            {preview.warnings.map((warning) => (
              <Banner key={warning} tone="warn">
                {warning}
              </Banner>
            ))}
            <div className="space-y-3 rounded-xl border border-line bg-panel2 p-3">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="fleet-promote-canary">Canary first</Label>
                <Switch id="fleet-promote-canary" checked={canaryEnabled} disabled={preview.targets.length === 0} onCheckedChange={setCanaryEnabled} />
              </div>
              {canaryEnabled && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="fleet-promote-instance">Canary instance</Label>
                    <Select value={canaryInstance} onValueChange={setCanaryInstance}>
                      <SelectTrigger id="fleet-promote-instance">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {preview.targets.map((target) => (
                          <SelectItem key={target.instanceId} value={String(target.instanceId)}>
                            {instanceNames.get(target.instanceId) ?? target.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="fleet-promote-wait">Observe for (seconds)</Label>
                    <Input id="fleet-promote-wait" inputMode="numeric" value={waitSeconds} onChange={(event) => setWaitSeconds(event.target.value)} />
                  </div>
                  <div className="flex items-end gap-2 pb-2">
                    <Switch id="fleet-promote-caddy" checked={checkCaddy} onCheckedChange={setCheckCaddy} />
                    <Label htmlFor="fleet-promote-caddy">Check Caddy status</Label>
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <h4 className="font-semibold">
                Changes{preview.currentRevisionId !== null ? ` from revision #${preview.currentRevisionId}` : " (the environment has no revision yet)"}
              </h4>
              <DiffView diff={preview.diff} empty="The configuration does not change." />
            </div>
          </>
        )}
        {error && (
          <Banner tone="bad" live>
            {error}
          </Banner>
        )}
      </div>
    </AppDialog>
  );
}

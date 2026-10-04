// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { HistorySettings } from "@/ee/config-history/settings";
import { jsonInit, requestJson } from "@/src/lib/request-json";

type Props = {
  open: boolean;
  onClose: () => void;
  settings: HistorySettings;
  configurable: boolean;
  canWrite: boolean;
  total: number;
  limits: { minRetention: number; maxRetention: number };
  /** Something changed on the server; `message` says what. */
  onChanged: (message: string) => void;
};

/**
 * Recording and retention, and deleting every version. Without a license
 * recording can be turned off (and kept off), never on; deleting never needs one.
 */
export function HistorySettingsDialog({ open, onClose, settings, configurable, canWrite, total, limits, onChanged }: Props) {
  const [pending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [retention, setRetention] = useState(String(settings.retention));
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [lastSeen, setLastSeen] = useState(settings);

  // Follow the server's settings when they change (after a save and refresh).
  if (lastSeen.enabled !== settings.enabled || lastSeen.retention !== settings.retention) {
    setLastSeen(settings);
    setEnabled(settings.enabled);
    setRetention(String(settings.retention));
  }

  const changed = enabled !== settings.enabled || retention !== String(settings.retention);
  const editable = canWrite && (configurable || !enabled);

  function save() {
    setError(null);
    if (!changed) {
      onClose();
      return;
    }
    const value = Number(retention);
    if (!Number.isInteger(value) || value < limits.minRetention || value > limits.maxRetention) {
      setError(`Keep between ${limits.minRetention} and ${limits.maxRetention} versions.`);
      return;
    }
    startTransition(async () => {
      try {
        await requestJson("/api/v1/config-history/settings", jsonInit("PUT", { enabled, retention: value }));
        onChanged(enabled ? `Recording is on; the newest ${value} versions are kept.` : "Recording is off.");
        onClose();
      } catch (caught) {
        setError((caught as Error).message);
      }
    });
  }

  function deleteAll() {
    setError(null);
    startTransition(async () => {
      try {
        await requestJson("/api/v1/config-history", { method: "DELETE" });
        setConfirmDeleteAll(false);
        onChanged(`Deleted all ${total} versions. The live configuration did not change.`);
        onClose();
      } catch (caught) {
        setConfirmDeleteAll(false);
        setError((caught as Error).message);
      }
    });
  }

  return (
    <>
      <AppDialog
        open={open && !confirmDeleteAll}
        onClose={onClose}
        title="History settings"
        submitLabel="Save"
        onSubmit={canWrite ? save : undefined}
        isSubmitting={pending}
        maxWidth="md"
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="history-enabled">Record a version after every change</Label>
              <p className="m-0 text-xs text-muted-foreground">Every change Caddy accepts that alters the configuration is saved as a version.</p>
            </div>
            <Switch
              id="history-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={pending || !canWrite || (!configurable && !settings.enabled)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="history-retention">Versions to keep</Label>
            <Input
              id="history-retention"
              type="number"
              min={limits.minRetention}
              max={limits.maxRetention}
              value={retention}
              onChange={(event) => setRetention(event.target.value)}
              disabled={pending || !editable}
              className="max-w-40"
            />
            <p className="m-0 text-xs text-muted-foreground">Older versions are deleted.</p>
          </div>
          {!configurable && (
            <p className="m-0 text-xs text-muted-foreground">
              Without a license recording can be turned off, not on; versions already kept stay visible and can be deleted.
            </p>
          )}
          {!canWrite && <p className="m-0 text-xs text-muted-foreground">Your role can read the history but not change these settings.</p>}
          {canWrite && total > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <p className="m-0 flex-[1_1_220px] text-xs text-muted-foreground">
                Deleting the versions does not change the live configuration.
              </p>
              <Button variant="danger" size="sm" onClick={() => setConfirmDeleteAll(true)} disabled={pending}>
                <Trash2 /> Delete all versions
              </Button>
            </div>
          )}
          {error && (
            <Banner tone="bad" live>
              {error}
            </Banner>
          )}
        </div>
      </AppDialog>

      <AppDialog
        open={open && confirmDeleteAll}
        onClose={() => setConfirmDeleteAll(false)}
        title="Delete all versions?"
        submitLabel="Delete"
        onSubmit={deleteAll}
        isSubmitting={pending}
      >
        <p className="m-0 text-sm">
          All <span className="num">{total}</span> versions are deleted. The live configuration does not change.
        </p>
      </AppDialog>
    </>
  );
}

// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppDialog } from "@/components/ui/AppDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KpiTile } from "@/components/ui/KpiTile";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import {
  DEFAULT_SHARED_STATE_PREFIX,
  type SharedStateActionResult,
  type SharedStateStatus,
  type SharedStateStatusActionResult,
  type SharedStateView,
} from "../shared-state/types";

type Props = {
  view: SharedStateView;
  canWrite: boolean;
  editionLabel: string;
  save: (input: Record<string, unknown>) => Promise<SharedStateActionResult>;
  remove: () => Promise<SharedStateActionResult>;
  loadStatus: () => Promise<SharedStateStatusActionResult>;
};

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-line py-3.5 first:border-t-0">
      <div className="flex min-w-0 flex-[0_1_210px] flex-col gap-0.5 pt-[7px]">
        <div className="font-medium">{label}</div>
        {hint && <div className="text-xs leading-4 text-soft">{hint}</div>}
      </div>
      <div className="min-w-0 flex-[1_1_320px] pt-[7px]">{children}</div>
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "never" : date.toLocaleString();
}

function StatusPanel({ status, onRefresh, pending }: { status: SharedStateStatus | null; onRefresh: () => void; pending: boolean }) {
  return (
    <SectionCard
      title="Status"
      headingLevel={3}
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={onRefresh} disabled={pending} aria-label="Refresh the shared state status">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      }
      padded
    >
      {!status ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3 text-sm" data-testid="shared-state-status">
          <div className="flex flex-wrap items-center gap-4">
            {status.reachable === null ? (
              <StatusDot tone="off" label="Off: this node keeps request-path state in its own database" />
            ) : status.reachable ? (
              <StatusDot tone="ok" label="This node reaches Redis/Valkey" />
            ) : (
              <StatusDot tone="bad" label={status.error ?? "This node cannot reach Redis/Valkey"} />
            )}
            <StatusDot tone={status.leader ? "info" : "off"} label={status.leader ? "This node writes balances back to the ledger" : "Another node writes balances back"} />
          </div>
          {status.keys && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <KpiTile size="sm" label="Forward-auth sessions" value={status.keys.forwardAuthSessions.toLocaleString()} />
              <KpiTile size="sm" label="API consumers with shared balances" value={status.keys.monetizationConsumers.toLocaleString()} />
              <KpiTile size="sm" label="Credits not yet in the ledger" value={status.keys.pendingCredits.toLocaleString()} />
            </div>
          )}
          {status.backend === "redis" && status.reachable && (
            <p className="text-muted-foreground">
              Last write-back to the ledger: <span className="num">{formatTime(status.drain?.at ?? null)}</span>
              {status.drain && ` (${status.drain.consumers} consumer(s), ${status.drain.credits} credit(s))`}
              {status.drain?.error && <span className="text-bad">. {status.drain.error}</span>}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

export default function SharedStateSection({ view: initialView, canWrite, editionLabel, save, remove, loadStatus }: Props) {
  const router = useRouter();
  const { productName } = useBranding();
  const [view, setView] = useState(initialView);
  const [prefix, setPrefix] = useState(initialView.keyPrefix || DEFAULT_SHARED_STATE_PREFIX);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SharedStateStatus | null>(null);
  const [confirm, setConfirm] = useState<null | "on" | "off" | "remove" | "prefix">(null);
  const [pending, startTransition] = useTransition();

  const writable = canWrite && view.editable;
  const canEnable = writable && view.configurable && view.connection.configured;

  const refresh = useCallback(() => {
    startTransition(async () => {
      const outcome = await loadStatus();
      if (outcome.ok) setStatus(outcome.status);
      else setError(outcome.error);
    });
  }, [loadStatus]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function settle(result: SharedStateActionResult, message: string) {
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setView(result.view);
    setPrefix(result.view.keyPrefix);
    toast.success(message);
    router.refresh();
    refresh();
  }

  function run(input: Record<string, unknown>, message: string) {
    setError(null);
    setConfirm(null);
    startTransition(async () => settle(await save(input), message));
  }

  function onRemove() {
    setError(null);
    setConfirm(null);
    startTransition(async () => settle(await remove(), "Shared state setting removed"));
  }

  const badge =
    view.backend === "redis" ? (
      <Badge variant="success">On: Redis/Valkey</Badge>
    ) : view.enabled ? (
      <Badge variant="destructive">On, not usable</Badge>
    ) : (
      <Badge variant="secondary">Off</Badge>
    );

  return (
    <div className="flex flex-col gap-4" data-testid="shared-state-section">
      <SectionCard
        title="Shared state"
        headingLevel={3}
        actions={<Badge variant="outline">{editionLabel}</Badge>}
        footer={
          writable ? (
            <div className="flex flex-wrap justify-end gap-2">
              {view.updatedAt && (
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm("remove")}>
                  Remove setting
                </Button>
              )}
              {view.enabled && view.configurable && prefix.trim() !== view.keyPrefix && (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirm("prefix")}>
                  Change prefix
                </Button>
              )}
              {view.enabled ? (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirm("off")}>
                  Turn off
                </Button>
              ) : (
                <Button type="button" size="sm" disabled={pending || !canEnable} onClick={() => setConfirm("on")}>
                  Turn on
                </Button>
              )}
            </div>
          ) : undefined
        }
        padded
      >
        <div className="flex flex-col text-sm">
          <p className="pb-3 text-muted-foreground">
            With several web nodes, keep forward-auth sessions, sign-in codes and API monetization balances in Redis or Valkey instead of
            each node&apos;s own database, so a user signed in through one node passes on every node and API consumers are charged once
            for the whole cluster. {productName} writes the balances back to the ledger every few seconds.
          </p>
          <Row label="State">{badge}</Row>
          <Row label="Connection" hint="The Redis or Valkey settings of the certificate storage, above">
            {view.connection.configured ? (
              <span className="num">
                {view.connection.mode}: {view.connection.addresses.join(", ")}
                {view.connection.tls ? ", TLS" : ""}
              </span>
            ) : (
              <span className="text-muted-foreground">Not configured: save Redis or Valkey settings for the certificate storage first (enabled or not).</span>
            )}
          </Row>
          <Row label="Key prefix" hint="Every key starts with it, then a part that changes each time shared state is turned on">
            <Input
              aria-label="Shared state key prefix"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              disabled={!writable || !view.configurable || pending}
              className="num max-w-xs"
            />
            {view.namespace && <p className="mt-1 text-xs text-soft num">{view.namespace}…</p>}
          </Row>
        </div>
      </SectionCard>

      {!view.configurable && (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertDescription>
            Shared state needs an active {editionLabel} license. State that is already shared keeps working and is shown read-only; you can
            still turn it off or remove the setting.{" "}
            <Link href="/license" className="underline underline-offset-4">
              Manage the license
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {!view.editable && (
        <Alert>
          <AlertDescription>This instance is a sync replica: replicas keep request-path state in their own database.</AlertDescription>
        </Alert>
      )}
      {view.error && (
        <Alert variant="destructive">
          <AlertDescription>
            {view.error}. Until it is fixed, forward-auth sign-ins and monetized APIs are refused on this node rather than counted on it alone.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <StatusPanel status={status} onRefresh={refresh} pending={pending} />

      <AppDialog
        open={confirm === "on"}
        onClose={() => setConfirm(null)}
        title="Turn on shared state?"
        maxWidth="md"
        submitLabel="Turn on"
        isSubmitting={pending}
        onSubmit={() => run({ enabled: true, keyPrefix: prefix.trim() }, "Shared state turned on")}
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>Every web node then keeps forward-auth sessions and API balances in Redis or Valkey.</p>
          <p>Users signed in through forward auth sign in once more. API balances continue from the ledger.</p>
        </div>
      </AppDialog>
      <AppDialog
        open={confirm === "prefix"}
        onClose={() => setConfirm(null)}
        title="Move shared state to another key prefix?"
        maxWidth="md"
        submitLabel="Move"
        isSubmitting={pending}
        onSubmit={() => run({ enabled: true, keyPrefix: prefix.trim() }, "Shared state moved")}
      >
        <p className="text-sm">
          The balances are written to the ledger first. Users signed in through forward auth sign in once more.
        </p>
      </AppDialog>
      <AppDialog
        open={confirm === "off"}
        onClose={() => setConfirm(null)}
        title="Turn off shared state?"
        maxWidth="md"
        submitLabel="Turn off"
        isSubmitting={pending}
        onSubmit={() => run({ enabled: false }, "Shared state turned off")}
      >
        <p className="text-sm">
          The shared API balances are written to the ledger first; if that fails nothing changes. Each node then keeps its own state again,
          and users signed in through forward auth sign in once more.
        </p>
      </AppDialog>
      <AppDialog
        open={confirm === "remove"}
        onClose={() => setConfirm(null)}
        title="Remove the shared state setting?"
        maxWidth="md"
        submitLabel="Remove"
        isSubmitting={pending}
        onSubmit={onRemove}
      >
        <p className="text-sm">
          Shared state is turned off even if Redis or Valkey cannot be reached. Usage and top-ups not yet written to the ledger are then lost.
        </p>
      </AppDialog>
    </div>
  );
}

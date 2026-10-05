// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Banner } from "@/components/ui/Banner";
import { SectionCard } from "@/components/ui/SectionCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { MonetizationOptionsView, ReplicaMode } from "../types";
import { callApi, Field, LOCKED_HINT } from "./shared";

const MODE_HINTS: Record<ReplicaMode, string> = {
  off: "Only this instance serves monetized hosts.",
  shared:
    "Replicas charge the same balances through the shared state (Redis or Valkey) with this instance's credentials: use it only for replicas you trust like this instance.",
  allowance: "Replicas take small prepaid allowances from this instance's gate. A replica that cannot reach the gate refuses requests.",
};

/** Install-wide options: usage history retention, serving monetized hosts on sync replicas. */
export default function SettingsTab({
  options,
  canWrite,
  canManageReplicas,
  configurable,
  instanceMode,
}: {
  options: MonetizationOptionsView;
  canWrite: boolean;
  /** monetization:write and instances:write. */
  canManageReplicas: boolean;
  configurable: boolean;
  instanceMode: "standalone" | "master" | "slave";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [months, setMonths] = useState(String(options.usageRetentionMonths));
  const [mode, setMode] = useState<ReplicaMode>(options.replicas.mode);
  const [gateUrl, setGateUrl] = useState(options.replicas.gateUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  // Turning replica serving off works without a license; everything else needs it.
  const canChange = canWrite && configurable;

  function save(body: Record<string, unknown>, message: string) {
    setError(null);
    startTransition(async () => {
      try {
        await callApi("/settings", "PUT", body);
        toast.success(message);
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <SectionCard
        title="Usage history"
        description="Usage and failed-answer credit entries older than this are deleted. Top-ups, payments, refunds, disputes and adjustments are kept, and balances never change."
      >
        <div className="flex flex-wrap items-end gap-3 px-[18px] py-4">
          <div className="w-40">
            <Field label="Keep for (months)" htmlFor="retention-months" hint="1 to 120; default 13">
              <Input id="retention-months" inputMode="numeric" className="num" value={months} onChange={(event) => setMonths(event.target.value)} />
            </Field>
          </div>
          {canWrite && (
            <Button
              variant="outline"
              disabled={pending || !canChange}
              title={canChange ? undefined : LOCKED_HINT}
              onClick={() => save({ usageRetentionMonths: Number(months) }, "Retention saved")}
            >
              Save
            </Button>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Sync replicas">
        <div className="flex flex-col gap-4 px-[18px] py-4">
          {instanceMode === "slave" && (
            <Banner tone="info" title="This instance is a replica.">
              Its monetized hosts, if any, come from its master, which decides whether replicas serve them.
            </Banner>
          )}
          {options.replicas.problem && options.replicas.mode !== "off" && (
            <Banner tone="warn" title="Replicas do not serve monetized hosts now.">
              {options.replicas.problem}
            </Banner>
          )}
          <Field label="Serve monetized hosts on replicas" hint={MODE_HINTS[mode]}>
            <Select value={mode} onValueChange={(value) => setMode(value as ReplicaMode)}>
              <SelectTrigger aria-label="Serve monetized hosts on replicas" className="sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">No, this instance only</SelectItem>
                <SelectItem value="shared">Yes, through shared state</SelectItem>
                <SelectItem value="allowance">Yes, with allowances from this gate</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {mode === "allowance" && (
            <Field
              label="Gate URL for replicas"
              htmlFor="replica-gate-url"
              hint="Where pushed replicas reach this instance, over https. Empty: BASE_URL. Pull replicas use the master URL they poll."
            >
              <Input
                id="replica-gate-url"
                className="num sm:w-[420px]"
                placeholder="https://dash.example.com"
                value={gateUrl}
                onChange={(event) => setGateUrl(event.target.value)}
              />
            </Field>
          )}
          {canWrite && !canManageReplicas && (
            <p className="m-0 text-[13px] text-muted-foreground">Changing this needs permission to manage instances (instances:write) as well.</p>
          )}
          {canManageReplicas && (
            <div>
              <Button
                variant="outline"
                disabled={pending || (!canChange && mode !== "off")}
                title={canChange || mode === "off" ? undefined : LOCKED_HINT}
                onClick={() => save({ replicas: { mode, gateUrl: mode === "allowance" ? gateUrl.trim() || null : null } }, "Replica serving saved")}
              >
                Save
              </Button>
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Failed-answer credits">
        <p className="m-0 px-[18px] py-4 text-[13px] text-muted-foreground">
          {options.analyticsAvailable
            ? "Available. Turn it on per plan to credit back requests answered with a 5xx."
            : "Not available: it needs ClickHouse analytics. Plans that already have it resume crediting once ClickHouse is back."}
        </p>
      </SectionCard>
    </div>
  );
}

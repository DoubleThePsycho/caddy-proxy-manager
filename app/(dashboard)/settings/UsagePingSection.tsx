"use client";

import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusChip } from "@/components/ui/StatusChip";
import { Switch } from "@/components/ui/switch";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { documentationUrl } from "@/src/lib/brand";
import type { UsagePingView } from "@/src/lib/usage-ping/store";
import { resetUsagePingInstallIdAction, setUsagePingEnabledAction, type UsagePingActionResult } from "./usage-ping-actions";

const STATUS_CHIPS: Record<UsagePingView["status"], { status: "active" | "inactive" | "warning"; label: string }> = {
  on: { status: "active", label: "On" },
  unanswered: { status: "inactive", label: "Off, not answered yet" },
  off: { status: "inactive", label: "Off" },
  disabled_by_env: { status: "inactive", label: "Turned off by the environment" },
  replica: { status: "inactive", label: "Replica: never sends" },
  invalid_endpoint: { status: "warning", label: "Not sending" },
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line py-2.5">
      <dt className="flex-[0_0_120px] text-[13px] text-muted-foreground">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-[1_1_200px] flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function when(value: string | null): string {
  return value ? formatDateTimeUtc(value) : "Never";
}

export default function UsagePingSection({ initial, canWrite }: { initial: UsagePingView; canWrite: boolean }) {
  const [view, setView] = useState(initial);
  const [pending, startTransition] = useTransition();
  const chip = STATUS_CHIPS[view.status];
  const canTurnOn = !view.disabledByEnv && view.role !== "slave";

  function run(action: () => Promise<UsagePingActionResult>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setView(result.view);
        toast.success(success);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-start gap-4" data-testid="usage-ping-section">
      <SectionCard
        title="Status"
        headingLevel={3}
        divided={false}
        className="flex-[1_1_360px]"
        actions={<StatusChip status={chip.status} label={chip.label} className="shrink-0" />}
      >
        <div className="flex flex-col gap-3.5 px-5 pb-4">
          <p className="m-0 text-[13px] text-muted-foreground [text-wrap:pretty]">
            Off unless an administrator says yes, here or in the question on the overview page. While it is on, this install
            sends one small JSON document a day: its version, edition, role, rough counts (ranges such as 6-20) and which
            features are in use, with a random install id. It never sends hostnames, domains, IP addresses, e-mails, names,
            license ids, configuration or anything from logs. The totals help decide what to fix and support. Turning it off
            deletes the install id and asks the receiving service to delete what it stored; see{" "}
            <a href={documentationUrl("documentation/usage-ping.md")} target="_blank" rel="noreferrer" className="text-brand underline underline-offset-4 hover:text-foreground">
              the privacy notice
            </a>
            .
          </p>

          {view.disabledByEnv && (
            <Banner tone="info">
              The <code className="num text-xs">USAGE_PING_DISABLED</code> environment variable turns the usage ping off on
              this install: nothing is sent and it cannot be turned on here.
            </Banner>
          )}
          {!view.disabledByEnv && view.role === "slave" && (
            <Banner tone="info">
              This instance is an instance sync replica. Replicas never send the usage ping; the setting is per install and is
              not synced.
            </Banner>
          )}
          {view.status === "invalid_endpoint" && view.endpointError && (
            <Banner tone="bad">{view.endpointError}. Nothing is sent until it is fixed.</Banner>
          )}

          <div className="flex min-h-9 items-center gap-2.5">
            <Switch
              id="usage-ping-enabled"
              checked={view.enabled}
              disabled={pending || !canWrite || (!view.enabled && !canTurnOn)}
              onCheckedChange={(checked) =>
                run(
                  () => setUsagePingEnabledAction(checked),
                  checked
                    ? "Usage ping turned on"
                    : "Usage ping turned off, its install id deleted and the receiving service asked to delete its data"
                )
              }
            />
            <Label htmlFor="usage-ping-enabled" className="font-medium">
              Send the anonymous usage ping once a day
            </Label>
          </div>
        </div>

        <dl className="m-0 px-5 pb-1.5">
          <Row label="Endpoint">
            <code className="num text-xs">{view.endpoint ?? "None"}</code>
          </Row>
          <Row label="Install id">
            {view.installId ? (
              <>
                <code className="num text-xs">{view.installId}</code>
                {canWrite && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => run(resetUsagePingInstallIdAction, "Install id reset")}
                  >
                    <RotateCcw />
                    Reset
                  </Button>
                )}
              </>
            ) : (
              "None (created when the ping is turned on, deleted when it is turned off)"
            )}
          </Row>
          <Row label="Answered">
            {view.answeredAt
              ? `${formatDateTimeUtc(view.answeredAt)}${view.answeredBy === "environment" ? " (USAGE_PING_ENABLED)" : ""}`
              : "Not yet"}
          </Row>
          <Row label="Next ping">{view.nextAttemptAt ? formatDateTimeUtc(view.nextAttemptAt) : "Not scheduled"}</Row>
          <Row label="Last sent">{when(view.lastSuccessAt)}</Row>
          {view.pendingErasures > 0 && (
            <Row label="Deletion requests">
              {view.pendingErasures} not delivered yet; retried every 6 hours for 7 days
            </Row>
          )}
          {view.lastResult === "failed" && (
            <Row label="Last attempt">
              {when(view.lastAttemptAt)}: {view.lastError ?? "failed"}
            </Row>
          )}
        </dl>
      </SectionCard>

      <SectionCard title="What the next ping sends" headingLevel={3} divided={false} className="flex-[1_1_360px]">
        <div className="flex flex-col gap-3 px-5 pb-4">
          {view.payload ? (
            <>
              <pre
                className="num m-0 overflow-x-auto whitespace-pre-wrap rounded-[10px] border border-line bg-background px-3.5 py-3 text-xs leading-[18px] [overflow-wrap:anywhere]"
                data-testid="usage-ping-payload"
              >
                {JSON.stringify(view.payload, null, 2)}
              </pre>
              <p className="m-0 text-xs leading-[18px] text-soft">
                Built by the same code that sends it (<code className="num">src/lib/usage-ping/payload.ts</code> and{" "}
                <code className="num">collect.ts</code>); <code className="num">documentation/usage-ping.md</code> explains every
                field. Also returned by <code className="num">GET /api/v1/usage-ping</code>.
                {!view.installId && " The install id is a placeholder while the ping is off."}
              </p>
            </>
          ) : (
            <p className="m-0 text-[13px] text-muted-foreground">Nothing: replicas never send the usage ping.</p>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

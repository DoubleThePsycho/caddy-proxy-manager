// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import { FREE_CHANNEL_TYPES, FREE_RULE_TYPES, type AlertChannelView, type AlertRuleView, type RuleType } from "@/ee/alerting/types";
import type { AlertingLicenseView } from "@/ee/alerting/gate";
import { deleteAlertRuleAction, setAlertRuleEnabledAction } from "./actions";
import { conditionLine, RULE_SEVERITY } from "./format";
import { Chip, SeverityPill } from "./parts";
import { LOCKED_HINT } from "./RuleEditor";

type Props = {
  rules: AlertRuleView[];
  channels: AlertChannelView[];
  license: AlertingLicenseView;
  canWrite: boolean;
  onCreate: () => void;
  onEdit: (rule: AlertRuleView) => void;
};

function earliest(values: (string | null)[]): string | null {
  const present = values.filter((value): value is string => Boolean(value)).sort();
  return present[0] ?? null;
}

export default function RulesTab({ rules, channels, license, canWrite, onCreate, onEdit }: Props) {
  const router = useRouter();
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState<AlertRuleView | null>(null);

  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const freeChannel = (id: number) => {
    const channel = channelById.get(id);
    return channel ? FREE_CHANNEL_TYPES.includes(channel.type) : true;
  };
  const isFree = (type: RuleType, channelIds: number[]) => FREE_RULE_TYPES.includes(type) && channelIds.every(freeChannel);
  const canChange = (rule: AlertRuleView) => license.alerting || isFree(rule.type, rule.channelIds);
  const enabledCount = rules.filter((rule) => rule.enabled).length;

  function setEnabled(rule: AlertRuleView, enabled: boolean) {
    startTransition(async () => {
      const result = await setAlertRuleEnabledAction(rule.id, enabled);
      if (!result.ok) toast.error(result.error);
      router.refresh();
    });
  }

  function remove() {
    if (!confirmDelete) return;
    const rule = confirmDelete;
    startTransition(async () => {
      const result = await deleteAlertRuleAction(rule.id);
      if (result.ok) toast.success("Rule deleted");
      else toast.error(result.error);
      setConfirmDelete(null);
      router.refresh();
    });
  }

  return (
    <>
      <SectionCard
        title="Rules"
        description="A rule notifies once when its condition starts, at most once per cooldown, and again when it clears if you ask for it."
        actions={
          <span className="text-[13px] text-muted-foreground">
            <span className="num">{enabledCount}</span> of <span className="num">{rules.length}</span> rule{rules.length === 1 ? "" : "s"} on
          </span>
        }
        footer={
          rules.length > 0 ? (
            <span className="text-xs text-soft">
              Turning a rule off forgets what it was firing without sending resolve notices; a PagerDuty incident it opened stays open until closed there.
            </span>
          ) : undefined
        }
      >
        {rules.length === 0 ? (
          <EmptyState
            compact
            title="No rules yet"
            description="A rule says what to watch, which channels to tell and how often at most."
            action={
              canWrite ? (
                <Button size="sm" onClick={onCreate}>
                  <Plus /> New rule
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Condition</TableHead>
                <TableHead scope="col">Scope</TableHead>
                <TableHead scope="col">For</TableHead>
                <TableHead scope="col">Severity</TableHead>
                <TableHead scope="col">Channels</TableHead>
                <TableHead scope="col">Last fired</TableHead>
                <TableHead scope="col" className="text-right">Enabled</TableHead>
                {canWrite && (
                  <TableHead scope="col" className="w-[120px]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => {
                const locked = !canChange(rule);
                const severity = RULE_SEVERITY[rule.type];
                const firingSince = rule.enabled ? earliest(rule.firing.map((item) => item.firedAt)) : null;
                return (
                  <TableRow key={rule.id} className={cn("align-top", !rule.enabled && "opacity-60")}>
                    <TableCell className="py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold">{rule.name}</span>
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-soft">
                          {conditionLine(rule)}
                          {rule.explain && (
                            <span className="rounded-full border border-line2 px-1.5 text-[11px] leading-4 text-muted-foreground">AI explanation</span>
                          )}
                        </span>
                        {rule.enabled && rule.pending.length > 0 && (
                          <span className="text-xs text-warn">
                            <span className="num">{rule.pending.length}</span> waiting out the <span className="num">{rule.forMinutes}</span> min duration
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-3">{rule.scopeLabel}</TableCell>
                    <TableCell className="py-3 whitespace-nowrap">
                      {rule.forMinutes > 0 ? <span className="num">{rule.forMinutes} min</span> : <span className="text-muted-foreground">At once</span>}
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-col items-start gap-0.5">
                        <SeverityPill severity={severity.severity} />
                        {severity.note && <span className="text-xs text-soft">{severity.note}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      {rule.channelIds.length === 0 ? (
                        <span className="text-muted-foreground">None</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {rule.channelIds.map((id) => {
                            const channel = channelById.get(id);
                            const failing = Boolean(channel?.enabled && channel.lastDeliveryError);
                            return (
                              <Chip key={id} tone={failing ? "bad" : undefined} title={failing ? `Last delivery failed: ${channel!.lastDeliveryError}` : undefined}>
                                {channel?.name ?? `#${id}`}
                              </Chip>
                            );
                          })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 whitespace-nowrap">
                      {rule.enabled && rule.firing.length > 0 ? (
                        <StatusDot
                          tone="warn"
                          label={
                            <span className="font-semibold">
                              {`Firing (${rule.firing.length})${firingSince ? ` since ${format.date(firingSince)}` : ""}`}
                            </span>
                          }
                        />
                      ) : rule.lastFiredAt ? (
                        <span className="num">{format.dateTime(rule.lastFiredAt)}</span>
                      ) : (
                        <span className="text-soft">Never</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right">
                      {canWrite ? (
                        <Switch
                          checked={rule.enabled}
                          // Turning off always works; turning a paid rule on needs the license.
                          disabled={pending || (locked && !rule.enabled)}
                          onCheckedChange={(checked) => setEnabled(rule, checked)}
                          aria-label={`Enabled: ${rule.name}`}
                          title={locked && !rule.enabled ? LOCKED_HINT : undefined}
                        />
                      ) : (
                        <span className="text-muted-foreground">{rule.enabled ? "On" : "Off"}</span>
                      )}
                    </TableCell>
                    {canWrite && (
                      <TableCell className="py-2.5 text-right whitespace-nowrap">
                        <Button
                          variant="link"
                          size="sm"
                          className="px-2"
                          title={locked ? LOCKED_HINT : undefined}
                          disabled={locked}
                          onClick={() => onEdit(rule)}
                          aria-label={`Edit rule ${rule.name}`}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Delete"
                          aria-label={`Delete rule ${rule.name}`}
                          disabled={pending}
                          onClick={() => setConfirmDelete(rule)}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <AppDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={`Delete rule "${confirmDelete?.name ?? ""}"?`}
        submitLabel="Delete"
        onSubmit={remove}
        isSubmitting={pending}
      >
        <p className="text-sm text-muted-foreground">What it was firing is forgotten without resolve notices. Its history is kept.</p>
      </AppDialog>
    </>
  );
}

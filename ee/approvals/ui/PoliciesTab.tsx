// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AppDialog } from "@/components/ui/AppDialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  DEFAULT_REQUEST_TTL_HOURS,
  MAX_REQUEST_TTL_HOURS,
  MAX_REQUIRED_APPROVALS,
  OPERATION_LABELS,
  OPERATIONS,
  TARGET_LABELS,
  TARGET_TYPES,
  type ApprovalPolicyView,
  type ChangeWindow,
  type Operation,
  type TargetType,
} from "@/ee/approvals/types";
import { describeWindows } from "@/ee/approvals/windows";
import type { Weekday } from "@/ee/backups/types";
import { requestJson } from "./client-api";

const LOCKED_HINT = "Needs a license with Change approvals";
const DAYS: { day: Weekday; label: string }[] = [
  { day: "monday", label: "Mon" },
  { day: "tuesday", label: "Tue" },
  { day: "wednesday", label: "Wed" },
  { day: "thursday", label: "Thu" },
  { day: "friday", label: "Fri" },
  { day: "saturday", label: "Sat" },
  { day: "sunday", label: "Sun" },
];

type Form = {
  name: string;
  description: string;
  enabled: boolean;
  targetTypes: TargetType[];
  operations: Operation[];
  hostTags: string;
  requiredApprovals: string;
  allowEmergency: boolean;
  requestTtlHours: string;
  timeZone: string;
  windows: ChangeWindow[];
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
    description: "",
    enabled: true,
    targetTypes: [...TARGET_TYPES],
    operations: [...OPERATIONS],
    hostTags: "",
    requiredApprovals: "1",
    allowEmergency: true,
    requestTtlHours: String(DEFAULT_REQUEST_TTL_HOURS),
    timeZone: browserTimeZone(),
    windows: [],
  };
}

function formFromPolicy(policy: ApprovalPolicyView): Form {
  return {
    name: policy.name,
    description: policy.description ?? "",
    enabled: policy.enabled,
    targetTypes: policy.targetTypes,
    operations: policy.operations,
    hostTags: policy.hostTags.join(", "),
    requiredApprovals: String(policy.requiredApprovals),
    allowEmergency: policy.allowEmergency,
    requestTtlHours: String(policy.requestTtlHours),
    timeZone: policy.timeZone,
    windows: policy.windows,
  };
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function bodyFromForm(form: Form) {
  return {
    name: form.name,
    description: form.description.trim() || null,
    enabled: form.enabled,
    targetTypes: form.targetTypes,
    operations: form.operations,
    hostTags: form.hostTags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    requiredApprovals: Number(form.requiredApprovals),
    allowEmergency: form.allowEmergency,
    requestTtlHours: Number(form.requestTtlHours),
    timeZone: form.timeZone.trim(),
    windows: form.windows,
  };
}

export default function PoliciesTab({
  policies,
  configurable,
  canManage,
}: {
  policies: ApprovalPolicyView[];
  configurable: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<ApprovalPolicyView | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [deleting, setDeleting] = useState<ApprovalPolicyView | null>(null);
  const canEdit = canManage && configurable;

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setDialogOpen(true);
  }

  function openEdit(policy: ApprovalPolicyView) {
    setEditing(policy);
    setForm(formFromPolicy(policy));
    setDialogOpen(true);
  }

  function save() {
    startTransition(async () => {
      try {
        const body = bodyFromForm(form);
        if (editing) await requestJson(`/api/v1/approval-policies/${editing.id}`, "PUT", body);
        else await requestJson("/api/v1/approval-policies", "POST", body);
        toast.success(editing ? "Policy updated" : "Policy created");
        setDialogOpen(false);
        router.refresh();
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  }

  function setEnabled(policy: ApprovalPolicyView, enabled: boolean) {
    startTransition(async () => {
      try {
        await requestJson(`/api/v1/approval-policies/${policy.id}`, "PUT", { enabled });
        toast.success(enabled ? `“${policy.name}” enabled` : `“${policy.name}” disabled: its hosts are no longer protected`);
        router.refresh();
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  }

  function remove(policy: ApprovalPolicyView) {
    startTransition(async () => {
      try {
        await requestJson(`/api/v1/approval-policies/${policy.id}`, "DELETE");
        toast.success(`“${policy.name}” deleted`);
        setDeleting(null);
        router.refresh();
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  }

  function updateWindow(index: number, change: Partial<ChangeWindow>) {
    setForm((current) => ({
      ...current,
      windows: current.windows.map((window, i) => (i === index ? { ...window, ...change } : window)),
    }));
  }

  return (
    <SectionCard
      title="Approval policies"
      count={policies.length}
      description="Several policies on one change combine to the strictest."
      actions={
        canManage && (
          <Button onClick={openCreate} disabled={!configurable} title={configurable ? undefined : LOCKED_HINT}>
            <Plus /> New policy
          </Button>
        )
      }
    >
      {policies.length === 0 ? (
        <EmptyState
          compact
          icon={ShieldCheck}
          title="No policies yet: every host change is applied directly."
        />
      ) : (
        <Table className="min-w-[880px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Policy</TableHead>
              <TableHead scope="col">Protects</TableHead>
              <TableHead scope="col">Approvals</TableHead>
              <TableHead scope="col">Change window</TableHead>
              <TableHead scope="col">Requests expire</TableHead>
              <TableHead scope="col" className="w-24">
                Enabled
              </TableHead>
              {canManage && (
                <TableHead scope="col" className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.map((policy) => (
              <TableRow key={policy.id} className={cn("align-top", !policy.enabled && "text-muted-foreground")}>
                <TableCell>
                  <span className="flex flex-col gap-0.5">
                    <span className="font-semibold text-foreground">{policy.name}</span>
                    {policy.description && <span className="text-xs text-soft">{policy.description}</span>}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex flex-col gap-0.5">
                    <span>{policy.targetTypes.map((type) => `${TARGET_LABELS[type]}s`).join(", ")}</span>
                    <span className="text-xs text-soft">
                      {policy.hostTags.length > 0 ? (
                        <>
                          Tagged <span className="num">{policy.hostTags.join(", ")}</span>
                        </>
                      ) : (
                        "Every host"
                      )}{" "}
                      · {policy.operations.map((operation) => OPERATION_LABELS[operation].toLowerCase()).join(", ")}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex flex-col items-start gap-1">
                    <span>
                      <span className="num">{policy.requiredApprovals}</span> {policy.requiredApprovals === 1 ? "approver" : "approvers"}
                    </span>
                    {!policy.allowEmergency && <Badge variant="warning">No emergency changes</Badge>}
                  </span>
                </TableCell>
                <TableCell className="text-xs">
                  {describeWindows(policy.windows, policy.timeZone) ?? <span className="text-soft">Any time</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  After <span className="num">{policy.requestTtlHours}</span> h
                </TableCell>
                <TableCell>
                  <Switch
                    checked={policy.enabled}
                    disabled={!canManage || pending || (!policy.enabled && !configurable)}
                    onCheckedChange={(checked) => setEnabled(policy, checked)}
                    aria-label={`Enable ${policy.name}`}
                    title={!policy.enabled && !configurable ? LOCKED_HINT : undefined}
                  />
                </TableCell>
                {canManage && (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canEdit}
                        title={configurable ? "Edit" : LOCKED_HINT}
                        onClick={() => openEdit(policy)}
                        aria-label={`Edit ${policy.name}`}
                      >
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(policy)} aria-label={`Delete ${policy.name}`}>
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AppDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editing ? `Edit policy “${editing.name}”` : "New approval policy"}
        maxWidth="lg"
        submitLabel={editing ? "Save" : "Create"}
        isSubmitting={pending}
        onSubmit={save}
      >
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="policy-name">Name</Label>
              <Input id="policy-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Production" />
            </div>
            <div className="flex items-end gap-2 pb-2">
              <Switch id="policy-enabled" checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
              <Label htmlFor="policy-enabled">Enabled</Label>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="policy-description">Description</Label>
            <Textarea
              id="policy-description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              rows={2}
              placeholder="Optional: why these hosts are protected"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Host types</legend>
              {TARGET_TYPES.map((type) => (
                <label key={type} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.targetTypes.includes(type)}
                    onCheckedChange={() => setForm({ ...form, targetTypes: toggle(form.targetTypes, type) })}
                  />
                  {TARGET_LABELS[type]}s
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Changes that need approval</legend>
              {OPERATIONS.map((operation) => (
                <label key={operation} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.operations.includes(operation)}
                    onCheckedChange={() => setForm({ ...form, operations: toggle(form.operations, operation) })}
                  />
                  {OPERATION_LABELS[operation]}
                </label>
              ))}
            </fieldset>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="policy-tags">Host tags</Label>
            <Input
              id="policy-tags"
              value={form.hostTags}
              onChange={(event) => setForm({ ...form, hostTags: event.target.value })}
              placeholder="prod, pci (empty: every host)"
            />
            <p className="text-xs text-muted-foreground">Hosts with one of these tags, before or after the change.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="policy-approvals">Approvals needed</Label>
              <Input
                id="policy-approvals"
                inputMode="numeric"
                value={form.requiredApprovals}
                onChange={(event) => setForm({ ...form, requiredApprovals: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">1 to {MAX_REQUIRED_APPROVALS} people other than the requester.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="policy-ttl">Expires after (hours)</Label>
              <Input
                id="policy-ttl"
                inputMode="numeric"
                value={form.requestTtlHours}
                onChange={(event) => setForm({ ...form, requestTtlHours: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">Up to {MAX_REQUEST_TTL_HOURS} hours without enough approvals.</p>
            </div>
            <div className="flex items-start gap-2 pt-7">
              <Switch
                id="policy-emergency"
                checked={form.allowEmergency}
                onCheckedChange={(allowEmergency) => setForm({ ...form, allowEmergency })}
              />
              <Label htmlFor="policy-emergency" className="leading-snug">
                Allow emergency changes
              </Label>
            </div>
          </div>
          <div className="space-y-3 rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Change windows</p>
                <p className="text-xs text-muted-foreground">Approved changes wait for a window. None: any time.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="policy-timezone">Time zone</Label>
                <Input
                  id="policy-timezone"
                  value={form.timeZone}
                  onChange={(event) => setForm({ ...form, timeZone: event.target.value })}
                  className="w-48"
                />
              </div>
            </div>
            {form.windows.map((window, index) => (
              <div key={index} className="flex flex-wrap items-center gap-3 rounded-lg bg-panel2 p-2">
                <div className="flex flex-wrap gap-2">
                  {DAYS.map(({ day, label }) => (
                    <label key={day} className="flex items-center gap-1 text-xs">
                      <Checkbox checked={window.days.includes(day)} onCheckedChange={() => updateWindow(index, { days: toggle(window.days, day) })} />
                      {label}
                    </label>
                  ))}
                </div>
                <Input
                  aria-label="Start"
                  value={window.start}
                  onChange={(event) => updateWindow(index, { start: event.target.value })}
                  className="w-20"
                  placeholder="09:00"
                />
                <span className="text-sm">to</span>
                <Input
                  aria-label="End"
                  value={window.end}
                  onChange={(event) => updateWindow(index, { end: event.target.value })}
                  className="w-20"
                  placeholder="17:00"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove window"
                  onClick={() => setForm({ ...form, windows: form.windows.filter((_, i) => i !== index) })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setForm({
                  ...form,
                  windows: [...form.windows, { days: ["monday", "tuesday", "wednesday", "thursday", "friday"], start: "09:00", end: "17:00" }],
                })
              }
            >
              <Plus className="h-4 w-4" /> Add window
            </Button>
            <p className="text-xs text-muted-foreground">An end before the start runs past midnight.</p>
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete approval policy"
        submitLabel="Delete"
        isSubmitting={pending}
        onSubmit={() => deleting && remove(deleting)}
      >
        <p className="text-sm">
          Delete “{deleting?.name}”? Its hosts are no longer protected by it. Requests made under it stay as they are and can still
          be approved.
        </p>
      </AppDialog>
    </SectionCard>
  );
}

"use client";

/**
 * Path-based mTLS access rules of an existing host. They are a list of their
 * own (REST: /api/v1/proxy-hosts/{id}/mtls-access-rules) and are saved one by
 * one when added, changed or removed, not with the rest of the editor; a
 * protected host turns each into a change request.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Ban } from "lucide-react";
import type { MtlsAccessRule } from "@/lib/models/mtls-access-rules";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { AddButton } from "./fields";
import type { EditorClientCertificate, EditorMtlsRole } from "./types";

function toggle(list: number[], id: number): number[] {
  return list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
}

function RuleDialog({
  hostId,
  roles,
  certificates,
  existing,
  onClose,
  onSaved,
}: {
  hostId: number;
  roles: EditorMtlsRole[];
  certificates: EditorClientCertificate[];
  existing: MtlsAccessRule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pathPattern, setPathPattern] = useState(existing?.pathPattern ?? "*");
  const [priority, setPriority] = useState(String(existing?.priority ?? 0));
  const [description, setDescription] = useState(existing?.description ?? "");
  const [roleIds, setRoleIds] = useState<number[]>(existing?.allowedRoleIds ?? []);
  const [certIds, setCertIds] = useState<number[]>(existing?.allowedCertIds ?? []);
  const [denyAll, setDenyAll] = useState(existing?.denyAll ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!pathPattern.trim()) {
      setError("Enter the path the rule applies to.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(existing ? `/api/v1/proxy-hosts/${hostId}/mtls-access-rules/${existing.id}` : `/api/v1/proxy-hosts/${hostId}/mtls-access-rules`, {
        method: existing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pathPattern: pathPattern.trim(),
          priority: Number(priority) || 0,
          description: description.trim() || null,
          allowedRoleIds: roleIds,
          allowedCertIds: certIds,
          denyAll,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error ?? `The rule could not be saved (${response.status}).`);
        setSaving(false);
        return;
      }
      if (response.status === 202) toast.info(`Submitted for approval as change request #${body?.id ?? "?"}. The rule changes once it is approved and applied.`);
      onSaved();
      onClose();
    } catch {
      setError("The rule could not be saved: the server did not answer.");
      setSaving(false);
    }
  }

  return (
    <AppDialog open onClose={onClose} title={existing ? "Edit access rule" : "Add access rule"} submitLabel={existing ? "Save rule" : "Add rule"} onSubmit={submit} isSubmitting={saving}>
      <div className="flex flex-col gap-4">
        {error && (
          <Banner tone="bad" live>
            {error}
          </Banner>
        )}
        <div className="flex gap-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor="mtls-rule-path" className="text-[13px] font-medium">
              Path
            </label>
            <Input id="mtls-rule-path" value={pathPattern} onChange={(event) => setPathPattern(event.target.value)} className="num" aria-describedby="mtls-rule-path-hint" />
            <span id="mtls-rule-path-hint" className="text-xs text-soft">
              * for every path, /admin/* for everything under /admin.
            </span>
          </div>
          <div className="flex w-24 flex-col gap-1.5">
            <label htmlFor="mtls-rule-priority" className="text-[13px] font-medium">
              Priority
            </label>
            <Input id="mtls-rule-priority" value={priority} inputMode="numeric" onChange={(event) => setPriority(event.target.value)} className="num" />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="mtls-rule-description" className="text-[13px] font-medium">
            Description, optional
          </label>
          <Input id="mtls-rule-description" value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
        <div className="flex items-center gap-2.5 rounded-lg border border-line2 bg-bad-tint px-3 py-2">
          <Switch id="mtls-rule-deny" checked={denyAll} onCheckedChange={setDenyAll} />
          <label htmlFor="mtls-rule-deny" className="text-[13px]">
            Deny every client on this path
          </label>
        </div>
        <fieldset disabled={denyAll} className={cn("m-0 flex flex-col gap-3 border-0 p-0", denyAll && "opacity-40")}>
          <legend className="sr-only">Who may reach the path</legend>
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-medium">Roles</span>
            {roles.length === 0 ? (
              <span className="text-[13px] text-soft">No mTLS roles yet.</span>
            ) : (
              roles.map((role) => (
                <label key={role.id} className="flex items-center gap-2 py-0.5 text-[13px]">
                  <Checkbox checked={roleIds.includes(role.id)} onCheckedChange={() => setRoleIds((current) => toggle(current, role.id))} />
                  {role.name}
                </label>
              ))
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-medium">Single certificates</span>
            <span className="text-xs text-soft">They pass this path whatever their role.</span>
            <div className="max-h-36 overflow-y-auto">
              {certificates.map((certificate) => (
                <label key={certificate.id} className="flex items-center gap-2 py-0.5 text-[13px]">
                  <Checkbox checked={certIds.includes(certificate.id)} onCheckedChange={() => setCertIds((current) => toggle(current, certificate.id))} />
                  {certificate.commonName}
                </label>
              ))}
            </div>
          </div>
        </fieldset>
      </div>
    </AppDialog>
  );
}

export function MtlsAccessRules({ hostId, roles, certificates }: { hostId: number; roles: EditorMtlsRole[]; certificates: EditorClientCertificate[] }) {
  const [rules, setRules] = useState<MtlsAccessRule[] | null>(null);
  const [dialog, setDialog] = useState<{ rule: MtlsAccessRule | null } | null>(null);

  const load = useCallback(() => {
    fetch(`/api/v1/proxy-hosts/${hostId}/mtls-access-rules`)
      .then((response) => (response.ok ? response.json() : []))
      .then((value: MtlsAccessRule[]) => setRules(value))
      .catch(() => setRules([]));
  }, [hostId]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(rule: MtlsAccessRule) {
    const response = await fetch(`/api/v1/proxy-hosts/${hostId}/mtls-access-rules/${rule.id}`, { method: "DELETE" }).catch(() => null);
    if (!response) {
      toast.error("The rule could not be removed: the server did not answer.");
      return;
    }
    const body = await response.json().catch(() => null);
    if (response.status === 202) toast.info(`Submitted for approval as change request #${body?.id ?? "?"}. The rule is removed once it is approved and applied.`);
    else if (response.ok) setRules((current) => (current ?? []).filter((entry) => entry.id !== rule.id));
    else toast.error(body?.error ?? `The rule could not be removed (${response.status}).`);
  }

  const roleName = (id: number) => roles.find((role) => role.id === id)?.name ?? `Role #${id}`;
  const certName = (id: number) => certificates.find((certificate) => certificate.id === id)?.commonName ?? `Certificate #${id}`;

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3.5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium">Path-based access rules</span>
          <span className="text-xs text-soft">Saved as soon as you add, change or remove one.</span>
        </span>
        <AddButton onClick={() => setDialog({ rule: null })}>Add access rule</AddButton>
      </div>
      {rules === null ? (
        <p className="m-0 text-xs text-soft">Loading rules…</p>
      ) : rules.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">No rules: every trusted certificate reaches every path.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px]">
              <span className="num rounded bg-raise px-1.5 text-xs">{rule.pathPattern}</span>
              {rule.denyAll ? (
                <span className="inline-flex items-center gap-1 text-bad">
                  <Ban aria-hidden="true" className="h-3.5 w-3.5" /> Denied
                </span>
              ) : (
                <span className="min-w-0 flex-1 text-muted-foreground">
                  {[...rule.allowedRoleIds.map(roleName), ...rule.allowedCertIds.map(certName)].join(", ") || "Nobody (no role or certificate chosen)"}
                </span>
              )}
              <span className="ml-auto flex gap-1">
                <button type="button" onClick={() => setDialog({ rule })} className="h-7 rounded-md px-2 text-brand hover:bg-raise" aria-label={`Edit access rule ${rule.pathPattern}`}>
                  Edit
                </button>
                <button type="button" onClick={() => remove(rule)} className="h-7 rounded-md px-2 text-muted-foreground hover:bg-raise hover:text-foreground" aria-label={`Remove access rule ${rule.pathPattern}`}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {dialog && <RuleDialog hostId={hostId} roles={roles} certificates={certificates} existing={dialog.rule} onClose={() => setDialog(null)} onSaved={load} />}
    </div>
  );
}

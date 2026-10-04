"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MoreHorizontal, Plus, Users } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui/SectionCard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { IssuedClientCertificateView, MtlsRoleView } from "../page";
import { formatDate } from "../format";

type Props = {
  roles: MtlsRoleView[];
  clientCertificates: IssuedClientCertificateView[];
  canWrite: boolean;
};

async function apiError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || `Request failed (${res.status})`;
}

/** mTLS roles: groups of client certificates a proxy host's mutual TLS can require. */
export function MtlsRoles({ roles, clientCertificates, canWrite }: Props) {
  const [editing, setEditing] = useState<MtlsRoleView | null | false>(false);
  const [assigning, setAssigning] = useState<MtlsRoleView | null>(null);
  const [deleting, setDeleting] = useState<MtlsRoleView | null>(null);

  return (
    <SectionCard
      title="Roles"
      count={roles.length}
      description="A role groups client certificates; mutual TLS on a proxy host can require one."
      actions={
        canWrite && roles.length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
            <Plus />
            New role
          </Button>
        ) : undefined
      }
      divided={roles.length === 0}
    >
      {roles.length === 0 ? (
        <EmptyState
          compact
          icon={Users}
          title="No roles yet"
          description="Without roles, a proxy host trusts client certificates one by one."
          action={
            canWrite ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
                <Plus />
                New role
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-3 p-4 pt-0">
          {roles.map((role) => (
            <li key={role.id} className="flex items-start gap-3 rounded-xl border border-line bg-panel2 px-4 py-3.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-semibold">{role.name}</span>
                  <span className="text-xs text-soft">role</span>
                </span>
                <span className="text-[13px] text-muted-foreground">
                  {role.description ? `${role.description.replace(/[.\s]+$/, "")}. ` : ""}
                  <span className="num">{role.certificateIds.length}</span>{" "}
                  {role.certificateIds.length === 1 ? "certificate" : "certificates"} ·{" "}
                  {role.requiredBy.length === 0
                    ? "not required by any host yet"
                    : `required by ${role.requiredBy.slice(0, 2).map((host) => host.domain ?? host.name).join(", ")}${
                        role.requiredBy.length > 2 ? ` and ${role.requiredBy.length - 2} more` : ""
                      }`}
                </span>
              </div>
              {canWrite && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`More actions for role ${role.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setAssigning(role)}>Choose certificates</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setEditing(role)}>Edit</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => setDeleting(role)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing !== false && <RoleDialog role={editing} onClose={() => setEditing(false)} />}
      {assigning && (
        <AssignCertificatesDialog
          role={assigning}
          certificates={clientCertificates.filter((cert) => !cert.revokedAt)}
          onClose={() => setAssigning(null)}
        />
      )}
      {deleting && <DeleteRoleDialog role={deleting} onClose={() => setDeleting(null)} />}
    </SectionCard>
  );
}

function RoleDialog({ role, onClose }: { role: MtlsRoleView | null; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(role ? `/api/v1/mtls-roles/${role.id}` : "/api/v1/mtls-roles", {
        method: role ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      if (!res.ok) {
        setError(await apiError(res));
        return;
      }
      router.refresh();
      onClose();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={role ? "Edit role" : "New role"}
      maxWidth="sm"
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : role ? "Save" : "Create role"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mtls-role-name">Name</Label>
          <Input id="mtls-role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="staff" autoFocus />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mtls-role-description">Description</Label>
          <Input
            id="mtls-role-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
        {error && <p className="m-0 text-sm text-bad">{error}</p>}
      </form>
    </AppDialog>
  );
}

function AssignCertificatesDialog({
  role,
  certificates,
  onClose,
}: {
  role: MtlsRoleView;
  certificates: IssuedClientCertificateView[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [assigned, setAssigned] = useState<Set<number>>(() => new Set(role.certificateIds));
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(certId: number) {
    const isAssigned = assigned.has(certId);
    setBusy(certId);
    setError(null);
    try {
      const res = isAssigned
        ? await fetch(`/api/v1/mtls-roles/${role.id}/certificates/${certId}`, { method: "DELETE" })
        : await fetch(`/api/v1/mtls-roles/${role.id}/certificates`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ certificateId: certId }),
          });
      if (!res.ok) {
        setError(await apiError(res));
        return;
      }
      setAssigned((current) => {
        const next = new Set(current);
        if (isAssigned) next.delete(certId);
        else next.add(certId);
        return next;
      });
    } catch {
      setError("Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppDialog
      open
      onClose={() => {
        router.refresh();
        onClose();
      }}
      title={`Certificates in ${role.name}`}
      maxWidth="md"
      actions={
        <Button
          variant="outline"
          onClick={() => {
            router.refresh();
            onClose();
          }}
        >
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="m-0 text-sm text-bad">{error}</p>}
        {certificates.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">No active client certificates yet. Issue one from a certificate authority first.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line overflow-hidden rounded-lg border border-line p-0">
            {certificates.map((cert) => {
              const id = `role-${role.id}-cert-${cert.id}`;
              return (
                <li key={cert.id} className="flex items-center gap-3 px-3 py-2">
                  <Checkbox
                    id={id}
                    checked={assigned.has(cert.id)}
                    disabled={busy === cert.id}
                    onCheckedChange={() => void toggle(cert.id)}
                  />
                  <Label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 font-normal">
                    <span className="num truncate text-sm">{cert.commonName}</span>
                    <span className="text-xs text-soft">
                      {cert.caName ?? "Unknown CA"} · expires {formatDate(cert.validTo)}
                    </span>
                  </Label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AppDialog>
  );
}

function DeleteRoleDialog({ role, onClose }: { role: MtlsRoleView; onClose: () => void }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/mtls-roles/${role.id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await apiError(res));
        return;
      }
      router.refresh();
      onClose();
    } catch {
      setError("Network error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title="Delete role"
      maxWidth="sm"
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={remove} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete role"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm text-muted-foreground">
          Delete the role <strong className="text-foreground">{role.name}</strong>? Its certificates stay valid.
          {role.requiredBy.length > 0 &&
            ` ${role.requiredBy.length === 1 ? "1 proxy host requires" : `${role.requiredBy.length} proxy hosts require`} it.`}
        </p>
        {error && <p className="m-0 text-sm text-bad">{error}</p>}
      </div>
    </AppDialog>
  );
}

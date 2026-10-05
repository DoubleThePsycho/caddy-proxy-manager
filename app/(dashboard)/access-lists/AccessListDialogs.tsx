"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { AccessList } from "@/lib/models/access-lists";
import type { AccessListDefaultAction } from "@/lib/access-list-rules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { createAccessListAction, deleteAccessListAction } from "./actions";

const START_OPTIONS: Array<{ value: AccessListDefaultAction; title: string; hint: string }> = [
  { value: "allow", title: "Blocklist", hint: "Everyone gets in except the sources you deny. Also for basic auth only." },
  { value: "deny", title: "Allowlist", hint: "Only the sources you allow get in." },
];

export function NewAccessListDialog({
  open,
  onClose,
  onCreated,
  onStoredOnly,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (list: AccessList) => void;
  /** Created, but Caddy did not take the configuration. */
  onStoredOnly: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAction, setDefaultAction] = useState<AccessListDefaultAction>("allow");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setDefaultAction("allow");
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const result = await createAccessListAction({ name: name.trim(), description: description.trim() || null, defaultAction });
      if (!result.ok) {
        toast.error(result.error);
        if (result.saved) {
          onStoredOnly();
          onClose();
        }
        return;
      }
      toast.success(`Created ${result.value.name}`);
      onCreated(result.value);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New access list</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-access-list-name">Name</Label>
            <Input id="new-access-list-name" autoFocus value={name} maxLength={200} placeholder="Office and VPN" onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-access-list-description">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input id="new-access-list-description" value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Start as</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {START_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-panel px-3 py-2.5 text-sm transition-colors hover:bg-raise",
                    defaultAction === option.value && "border-brand bg-brand-tint hover:bg-brand-tint"
                  )}
                >
                  <input
                    type="radio"
                    name="new-access-list-start"
                    value={option.value}
                    checked={defaultAction === option.value}
                    onChange={() => setDefaultAction(option.value)}
                    className="mt-1 accent-brand"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-semibold">{option.title}</span>
                    <span className="text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || submitting}>{submitting ? "Creating" : "Create list"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteAccessListDialog({
  list,
  hostCount,
  onClose,
  onDeleted,
}: {
  /** The list to delete; null closes the dialog. */
  list: { id: number; name: string } | null;
  /** Hosts using it that the user can see. */
  hostCount: number;
  onClose: () => void;
  /** Called after the delete, also when Caddy did not take the configuration. */
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    if (!list) return;
    setDeleting(true);
    try {
      const result = await deleteAccessListAction(list.id);
      if (!result.ok) {
        toast.error(result.error);
        if (result.saved) onDeleted();
        onClose();
        return;
      }
      toast.success(`Deleted ${list.name}`);
      onDeleted();
      onClose();
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Dialog open={list !== null} onOpenChange={(next) => !next && !deleting && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {list?.name}?</DialogTitle>
          <DialogDescription>
            {hostCount > 0
              ? `${hostCount === 1 ? "The host" : `The ${hostCount} hosts`} using it lose its rules and users and let everyone in.`
              : "No host uses it."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={deleting}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={remove} disabled={deleting}>Delete list</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

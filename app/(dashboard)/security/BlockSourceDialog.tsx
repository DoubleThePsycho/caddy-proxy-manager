"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { blockSourceAction } from "../access-lists/actions";

/** An address to block, with a note that becomes the entry's reason. */
export type BlockTarget = { ip: string; country?: string | null; note?: string };

const EXPIRY = [
  { value: "never", label: "Never", seconds: null },
  { value: "1h", label: "1 hour", seconds: 3600 },
  { value: "24h", label: "24 hours", seconds: 86_400 },
  { value: "7d", label: "7 days", seconds: 7 * 86_400 },
  { value: "30d", label: "30 days", seconds: 30 * 86_400 },
] as const;
type ExpiryValue = (typeof EXPIRY)[number]["value"];

/** Longest reason an access list rule keeps (MAX_RULE_NOTE_LENGTH). */
const MAX_REASON = 500;

/**
 * Confirms blocking an address: it becomes a deny entry of the global
 * Blocked sources access list, which every host checks first. Optional
 * expiry; the entry is removed when it passes. blockSourceAction checks
 * access_lists:write.
 */
export function BlockSourceDialog({ target, onClose, onBlocked }: { target: BlockTarget | null; onClose: () => void; onBlocked?: (ip: string) => void }) {
  const [reason, setReason] = useState("");
  const [expiry, setExpiry] = useState<ExpiryValue>("never");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!target) return;
    setReason((target.note ?? "").slice(0, MAX_REASON));
    setExpiry("never");
    setError(null);
  }, [target]);

  function submit() {
    if (!target) return;
    const seconds = EXPIRY.find((option) => option.value === expiry)?.seconds ?? null;
    setError(null);
    startTransition(async () => {
      const result = await blockSourceAction({
        address: target.ip,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(seconds ? { expiresInSeconds: seconds } : {}),
      });
      if (!result.ok) {
        if (result.saved) toast.warning(result.error);
        else setError(result.error);
        if (!result.saved) return;
      } else {
        toast.success(`${target.ip} is blocked on every host${seconds ? ` for ${EXPIRY.find((option) => option.value === expiry)?.label}` : ""}.`);
      }
      onBlocked?.(target.ip);
      onClose();
    });
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Block {target?.ip}</DialogTitle>
          <DialogDescription>
            Every host refuses its requests (the <Link href="/access-lists?tab=blocked-sources" className="text-brand hover:underline">Blocked sources</Link> list).
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Unblock after
            </span>
            <SegmentedControl
              size="sm"
              label="Unblock after"
              value={expiry}
              onChange={setExpiry}
              options={EXPIRY.map((option) => ({ value: option.value, label: option.label }))}
              className="self-start"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="block-reason">
              Reason <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="block-reason"
              rows={2}
              maxLength={MAX_REASON}
              value={reason}
              onChange={(event) => setReason(event.target.value.replace(/\n/g, " "))}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-bad">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !target}>
              Block address
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

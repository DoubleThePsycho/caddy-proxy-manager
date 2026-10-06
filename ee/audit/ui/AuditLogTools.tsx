// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { AuditChainStatus } from "@/ee/audit/chain-status";
import type { AuditVerification } from "@/ee/audit/types";
import { verifyAuditLogAction } from "./actions";
import { shortHash } from "@/src/lib/audit-log-view";

export const selectClass =
  "h-9 w-full rounded-lg border border-line bg-panel px-3 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function exportUrl(format: string, from: string, to: string): string {
  const params = new URLSearchParams({ format });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return `/api/v1/audit-log/export?${params.toString()}`;
}

/** Download the audit log as CSV or JSON (audit_streaming feature), optionally for a date range. */
export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [format, setFormat] = useState("csv");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Export the audit log"
      actions={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button asChild onClick={onClose}>
            <a href={exportUrl(format, from, to)} download>
              <Download className="h-4 w-4" /> Download
            </a>
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="export-format">Format</Label>
          <select id="export-format" className={selectClass} value={format} onChange={(event) => setFormat(event.target.value)}>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="export-from">From (UTC)</Label>
            <Input id="export-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="export-to">To (UTC)</Label>
            <Input id="export-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
        </div>
        <p className="text-[13px] text-muted-foreground">Leave the dates empty to export everything.</p>
      </div>
    </AppDialog>
  );
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

/**
 * The hash chain's state from the last recorded verification, with "Verify
 * now".
 */
export function ChainBanner({ chain, licensed }: { chain: AuditChainStatus; licensed: boolean }) {
  const router = useRouter();
  const format = useFormat();
  const [verifying, startVerify] = useTransition();
  const [result, setResult] = useState<AuditVerification | null>(null);
  const [error, setError] = useState<string | null>(null);

  function verify() {
    setError(null);
    setResult(null);
    startVerify(async () => {
      const outcome = await verifyAuditLogAction();
      if ("error" in outcome) {
        setError(outcome.error);
        return;
      }
      setResult(outcome.result);
      router.refresh();
    });
  }

  const check = chain.lastCheck;
  const since = chain.eventsSinceCheck;
  const sinceText = since === 0 ? "Nothing recorded since." : `${format.number(since)} ${plural(since, "event")} recorded since.`;
  const tone = !check ? "info" : check.ok ? "ok" : "bad";
  const icon = !check ? Shield : check.ok ? ShieldCheck : ShieldAlert;
  const title = !check ? (
    "The hash chain has not been verified yet."
  ) : check.ok ? (
    <>
      Chain verified{check.checked !== null ? `, ${format.number(check.checked)} ${plural(check.checked, "event")}` : ""}, last check{" "}
      <span className="num">{format.dateTime(check.at)}</span>. <span className="font-normal text-muted-foreground">{sinceText}</span>
    </>
  ) : (
    <>
      The last check, <span className="num">{format.dateTime(check.at)}</span>, found a mismatch
      {check.firstMismatchId !== null && (
        <>
          {" "}
          at event <span className="num">#{check.firstMismatchId}</span>
        </>
      )}
      . <span className="font-normal text-muted-foreground">Events from there on may have been changed, removed or inserted.</span>
    </>
  );

  const anchorLine = [
    chain.anchor ? `Anchored at #${chain.anchor.id}` : null,
    chain.head ? `newest #${chain.head.id}` : null,
    chain.head ? `head hash ${shortHash(chain.head.hash)}` : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-2.5">
      <Banner
        tone={tone}
        icon={icon}
        layout="stacked"
        title={title}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={verify}
            disabled={!licensed || verifying}
            title={licensed ? undefined : "Verifying needs a Business license"}
          >
            {verifying ? "Verifying…" : "Verify now"}
          </Button>
        }
      >
        {anchorLine.length > 0 && <p className="num m-0 text-xs text-soft">{anchorLine.join(" · ")}</p>}
      </Banner>
      {error && (
        <Banner tone="bad" live onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {result && (
        <Banner
          tone={result.ok ? "ok" : "bad"}
          live
          onDismiss={() => setResult(null)}
          title={
            result.ok
              ? `Verified just now: ${format.number(result.checked)} ${plural(result.checked, "event")} intact.`
              : `Event #${result.firstMismatchId} failed verification.`
          }
        >
          {result.ok ? (
            <>
              Newest event <span className="num">#{result.headId ?? "-"}</span>, head hash{" "}
              <span className="num">{shortHash(result.headHash)}</span>. Compare it with a streamed or exported copy to rule out removed
              newest events.
            </>
          ) : (
            result.reason
          )}
        </Banner>
      )}
    </div>
  );
}

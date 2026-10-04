// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { ControlEvidence, ControlStatusView } from "../control-status";
import type { ComplianceFramework } from "../types";
import { CONTROL_TONE, FRAMEWORK_INFO } from "./format";

/** Evidence that points at this page or at the history page goes to the matching section. */
function evidenceHref(evidence: ControlEvidence): string {
  if (evidence.route === "/compliance") return "#restore-tests";
  if (evidence.route === "/history" && evidence.label === "Backup runs") return "/history?tab=backups";
  return evidence.route;
}

/** The live status of the six controls, with what was checked and the evidence. */
export default function ControlsTable({ controls, framework }: { controls: ControlStatusView; framework: ComplianceFramework }) {
  const format = useFormat();
  const { counts } = controls;
  return (
    <SectionCard
      title="Controls"
      description={
        <span className="inline-flex flex-wrap gap-x-3.5 gap-y-1 text-muted-foreground">
          <StatusDot tone="ok" label={<><span className="num text-foreground">{counts.met}</span> met</>} />
          <StatusDot tone="warn" label={<span className="text-muted-foreground"><span className="num text-foreground">{counts.attention}</span> need attention</span>} />
          <StatusDot tone="bad" label={<span className="text-muted-foreground"><span className="num text-foreground">{counts.not_met}</span> not met</span>} />
          {counts.unknown > 0 && (
            <StatusDot tone="off" label={<span className="text-muted-foreground"><span className="num text-foreground">{counts.unknown}</span> not checked</span>} />
          )}
        </span>
      }
      actions={
        <span className="text-[13px] text-soft">
          Checked <span className="num">{format.dateTime(controls.checkedAt)}</span>
        </span>
      }
    >
      <Table className="min-w-[1040px]">
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="w-[200px]">Control</TableHead>
            <TableHead scope="col" className="w-[140px]">Status</TableHead>
            <TableHead scope="col">What was checked</TableHead>
            <TableHead scope="col" className="w-[200px]">Evidence</TableHead>
            <TableHead scope="col" className="w-[200px]">{FRAMEWORK_INFO[framework].refHeading}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {controls.controls.map((control) => {
            const reference = framework === "nis2" ? control.references.nis2 : control.references.iso27001;
            return (
              <TableRow key={control.key} className="align-top hover:bg-transparent">
                <TableCell className="py-3 align-top font-semibold">{control.title}</TableCell>
                <TableCell className="py-3 align-top">
                  <StatusDot tone={CONTROL_TONE[control.status]} label={control.statusLabel} className="whitespace-nowrap" />
                </TableCell>
                <TableCell className="py-3 align-top text-muted-foreground">{control.checked}</TableCell>
                <TableCell className="py-3 align-top">
                  {control.evidence.length === 0 ? (
                    <span className="text-soft">None yet</span>
                  ) : (
                    <span className="flex flex-col gap-0.5">
                      {control.evidence.map((evidence) => (
                        <Link key={`${evidence.route}-${evidence.label}`} href={evidenceHref(evidence)} className="text-brand underline-offset-4 hover:underline">
                          {evidence.label}
                        </Link>
                      ))}
                    </span>
                  )}
                </TableCell>
                <TableCell className="py-3 align-top">
                  <span className="flex flex-col gap-0.5">
                    <span className="num">{reference.ref}</span>
                    <span className="text-xs text-soft">{reference.title}</span>
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

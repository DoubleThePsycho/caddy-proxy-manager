// SPDX-License-Identifier: Elastic-2.0
"use client";

import { Banner } from "@/components/ui/Banner";
import { SectionCard } from "@/components/ui/SectionCard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ControlMappingView, MappedSubject } from "../controls";
import { REPORT_TYPE_LABELS, isReportType, type ComplianceFramework, type ControlReference } from "../types";

function subjectLabel(subject: MappedSubject): string {
  return isReportType(subject) ? REPORT_TYPE_LABELS[subject] : "Incident notification drafts";
}

const FRAMEWORK_OF: Record<ComplianceFramework, ControlReference["framework"]> = { nis2: "NIS2", iso27001: "ISO/IEC 27001:2022" };

/** Which controls each report and the incident drafts can support; the chosen framework first. */
export default function ControlsTab({ mapping, framework }: { mapping: ControlMappingView; framework: ComplianceFramework }) {
  const subjects = Object.keys(mapping.mapping) as MappedSubject[];
  const first = FRAMEWORK_OF[framework];
  return (
    <div className="flex flex-col gap-5">
      <Banner tone="info" layout="stacked" title="Evidence, not proof">
        <p className="m-0">{mapping.statement}</p>
        <p className="m-0 mt-1.5">
          NIS2 references are to Article 21(2) and Article 23 of Directive (EU) 2022/2555; in Italy D.Lgs. 138/2024 transposes them (Articles 24 and 25),
          with ACN&apos;s determinations setting the detail. ISO references are to Annex A of ISO/IEC 27001:2022. Review the mapping against your own
          statement of applicability.
        </p>
      </Banner>
      {subjects.map((subject) => {
        const controls = [...mapping.mapping[subject]].sort((a, b) => Number(b.framework === first) - Number(a.framework === first));
        return (
          <SectionCard key={subject} title={subjectLabel(subject)} count={controls.length}>
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="w-40">Framework</TableHead>
                  <TableHead scope="col" className="w-80">Control</TableHead>
                  <TableHead scope="col">How it supports the control</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {controls.map((control) => (
                  <TableRow key={`${control.framework}-${control.ref}`} className="align-top hover:bg-transparent">
                    <TableCell className="align-top">{control.framework}</TableCell>
                    <TableCell className="align-top">
                      <span className="num font-medium">{control.ref}</span> {control.title}
                    </TableCell>
                    <TableCell className="align-top text-muted-foreground">{control.how}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SectionCard>
        );
      })}
    </div>
  );
}

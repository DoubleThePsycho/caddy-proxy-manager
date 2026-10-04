// SPDX-License-Identifier: Elastic-2.0
"use client";

import { StatusDot } from "@/components/ui/StatusDot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { STATUS_LABELS, type ChangeRequestView } from "@/ee/approvals/types";
import { decidedAt, decisionOf, describeRequest, operationLabel, STATUS_DOT } from "./request-format";
import { Initials } from "./RequestParts";

/** Decided requests: what changed, who asked, the outcome and who decided it. */
export default function DecidedTable({
  requests,
  selectedId,
  onSelect,
}: {
  requests: ChangeRequestView[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const format = useFormat();
  return (
    <Table className="min-w-[960px]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="w-20">
            Request
          </TableHead>
          <TableHead scope="col">Change</TableHead>
          <TableHead scope="col">Requested by</TableHead>
          <TableHead scope="col">Outcome</TableHead>
          <TableHead scope="col">Decision</TableHead>
          <TableHead scope="col">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {requests.map((request) => {
          const selected = request.id === selectedId;
          const decision = decisionOf(request);
          return (
            <TableRow key={request.id} className={cn("align-top", selected && "bg-brand-tint hover:bg-brand-tint")}>
              <TableCell className="num text-soft">#{request.id}</TableCell>
              <TableCell>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(request.id)}
                  className="flex min-w-0 flex-col gap-0.5 text-left"
                >
                  <span className="font-semibold underline-offset-4 hover:underline [overflow-wrap:anywhere]">{describeRequest(request)}</span>
                  <span className="text-xs text-soft">
                    {operationLabel(request)}
                    {request.policies.length > 0 && <> · policy {request.policies.map((policy) => policy.name).join(", ")}</>}
                  </span>
                </button>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <Initials name={request.requestedBy.name} />
                  {request.requestedBy.name}
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <StatusDot tone={STATUS_DOT[request.status]} label={request.emergency && request.status === "applied" ? "Applied, emergency" : STATUS_LABELS[request.status]} />
              </TableCell>
              <TableCell>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{decision.text}</span>
                  {decision.comment && <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">“{decision.comment}”</span>}
                </span>
              </TableCell>
              <TableCell className="num whitespace-nowrap text-muted-foreground">{format.dateTime(decidedAt(request))}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

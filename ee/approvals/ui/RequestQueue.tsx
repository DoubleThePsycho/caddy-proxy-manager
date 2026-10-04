// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import type { ChangeRequestView } from "@/ee/approvals/types";
import { describeRequest, operationLabel, shortStatus, STATUS_TONE } from "./request-format";
import { Initials, Pill } from "./RequestParts";

/** The open requests, oldest first, as a list of buttons that select one. */
export default function RequestQueue({
  requests,
  selectedId,
  now,
  onSelect,
  onShowPolicies,
}: {
  requests: ChangeRequestView[];
  selectedId: number | null;
  now: number;
  onSelect: (id: number) => void;
  onShowPolicies: () => void;
}) {
  const format = useFormat();
  return (
    <section aria-labelledby="queue-title" className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline gap-2.5 px-0.5">
        <h2 id="queue-title" className="m-0 text-base leading-6 font-semibold">
          Open requests
        </h2>
        <span className="text-[13px] text-soft">Oldest first</span>
      </div>
      {requests.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line2 bg-panel px-5 py-5">
          <p className="m-0">No change is waiting for approval.</p>
          <button type="button" onClick={onShowPolicies} className="text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline">
            Review the policies
          </button>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {requests.map((request) => {
            const selected = request.id === selectedId;
            return (
              <li key={request.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(request.id)}
                  className={cn(
                    "flex w-full flex-col gap-2 rounded-xl border px-4 py-3.5 text-left transition-colors",
                    selected ? "border-brand bg-brand-tint" : "border-line bg-panel hover:bg-panel2"
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="num text-xs text-soft">#{request.id}</span>
                    <span className="text-xs text-soft">{operationLabel(request)}</span>
                    {request.emergency && <Pill tone="destructive">Emergency</Pill>}
                    <Pill tone={STATUS_TONE[request.status]} className="ml-auto">
                      {shortStatus(request)}
                    </Pill>
                  </span>
                  <span className="text-sm leading-5 font-semibold [overflow-wrap:anywhere]">{describeRequest(request)}</span>
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Initials name={request.requestedBy.name} size="xs" />
                      {request.requestedBy.name}
                    </span>
                    <span title={format.dateTime(request.createdAt)}>{format.relative(request.createdAt, now)}</span>
                    {request.policies.length > 0 && <span>Policy {request.policies.map((policy) => policy.name).join(", ")}</span>}
                    <span>
                      Approvals{" "}
                      <span className="num text-foreground">
                        {request.approvals} of {request.requiredApprovals}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
